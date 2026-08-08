import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { WINDOW_CONFIGS } from "../types/index.js";
import {
  getDb,
  createSimulatedTrade,
  resolveTrade,
  updateTradeMinPrice,
  logAudit,
  loadOpenTradesWithMarkets,
  insertMarketIfNew,
} from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, and, desc, gte } from "drizzle-orm";

import { getMarketScanner, MarketScanner } from "./market-scanner.js";
import {
  getMarketWebSocketWatcher,
  MarketWebSocketWatcher,
} from "./market-ws-watcher.js";
import {
  getStrategyEngine,
  StrategyEngine,
  type MarketOpportunity,
} from "./strategy-engine.js";
import {
  simulateLimitBuy,
  simulateLimitSell,
  calculateWinProfit,
  calculateEarlyExitPnl,
} from "./execution-simulator.js";
import { getBtcPriceWatcher, BtcPriceWatcher } from "./btc-price-watcher.js";
import { recordCompletedMarket } from "./market-recorder.js";
import { marketNow } from "./market-clock.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";
import { PortfolioManager } from "./portfolio-manager.js";

import type {
  BookUpdateEvent,
  MarketResolvedEvent,
} from "../interfaces/websocket-types.js";

const logger = createModuleLogger("market-orchestrator");

interface ActiveMarketState {
  marketId: string;
  conditionId: string | null;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  slug: string | null;
  endDate: Date;
  targetPrice: number | null;
  /** BTC price at window start — the "price to beat"; the window resolves UP if
   *  BTC ends >= this value, DOWN otherwise. */
  btcPriceAtWindowStart: number | null;
  outcomes: string[];
  lastPrices: Record<string, { bid: number; ask: number }>;
  subscribedWs: boolean;
  resolved: boolean;
  /** Set once the oracle decides; recorded with the completed-window data. */
  winningOutcome: string | null;
  rawMarket: any;
}

interface OpenPosition {
  tradeId: string;
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  entryPrice: number;
  entryShares: number;
  fees: number;
  /** Cash spent (shares × avgPrice + fees); the cost basis for portfolio value. */
  actualCost: number;
  marketEndDate: Date;
  /** Lowest executable bid seen since entry (observational only). */
  minBid: number;
  stopTriggered?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Central coordinator: the scanner finds BTC window markets, this subscribes to
 * their CLOB price feed, the strategy engine flags entries, the execution
 * simulator fills them, and positions are resolved WIN/LOSS via WS + polling.
 */
export class MarketOrchestrator extends EventEmitter {
  private scanner: MarketScanner;
  private wsWatcher: MarketWebSocketWatcher;
  private strategyEngine: StrategyEngine;
  private btcWatcher: BtcPriceWatcher;
  private client: PolymarketClient;
  readonly portfolioManager: PortfolioManager;

  private activeMarkets: Map<string, ActiveMarketState> = new Map();
  /** conditionId → marketId */
  private conditionIdMap: Map<string, string> = new Map();
  /** tokenId → marketId */
  private tokenToMarket: Map<string, string> = new Map();
  private openPositions: Map<string, OpenPosition> = new Map();
  /** marketId → tradeIds */
  private positionsByMarket: Map<string, Set<string>> = new Map();
  /** tokenId → tradeIds */
  private positionsByToken: Map<string, Set<string>> = new Map();
  /** tokenIds mid-execution in onOpportunity — blocks concurrent duplicates */
  private inFlightTokenIds: Set<string> = new Set();
  /** marketIds still awaiting btcPriceAtWindowStart */
  private pendingBtcFills: Set<string> = new Set();
  private resolutionTimers: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private windowDurationMs = 5 * 60_000;

  private running = false;
  private paused = false;
  private cycleCount = 0;
  private consecutiveLossCount = 0;
  private pausedByRiskGuard = false;
  private riskPauseTriggeredAt: number | null = null;
  private riskAutoResumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.scanner = getMarketScanner();
    this.wsWatcher = getMarketWebSocketWatcher();
    this.strategyEngine = getStrategyEngine();
    this.btcWatcher = getBtcPriceWatcher();
    this.client = getPolymarketClient();
    this.portfolioManager = new PortfolioManager();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const config = getConfig();
    this.windowDurationMs =
      WINDOW_CONFIGS[config.strategy.marketWindow]?.durationMs ?? 5 * 60_000;
    const windowLabel = WINDOW_CONFIGS[config.strategy.marketWindow].label;

    await this.portfolioManager.init();

    logger.info(
      {
        window: config.strategy.marketWindow,
        label: windowLabel,
        zEntryThreshold: config.strategy.zEntryThreshold,
        entryFromWindowSec: config.strategy.entryFromWindowSeconds,
        budgetMaxUsd: config.portfolio.budgetMaxUsd,
        startingCapital: config.portfolio.startingCapital,
      },
      "Starting market orchestrator",
    );

    await this.loadOpenPositions();
    await this.loadActiveMarkets();
    this.tryFillBtcWindowStart();
    this.wireEvents();

    this.wsWatcher.start();
    await this.scanner.start();

    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), 10_000);

    logger.info("Market orchestrator fully started");
  }

  stop(): void {
    this.running = false;
    this.scanner.stop();
    this.wsWatcher.stop();
    if (this.riskAutoResumeTimer) {
      clearTimeout(this.riskAutoResumeTimer);
      this.riskAutoResumeTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const [, timer] of this.resolutionTimers) {
      clearTimeout(timer);
    }
    this.resolutionTimers.clear();

    logger.info("Market orchestrator stopped");
  }

  /** Pause new entries; open positions stay tracked and the WS stays alive. */
  pause(): void {
    this.paused = true;
    this.scanner.stop();
    if (this.riskAutoResumeTimer) {
      clearTimeout(this.riskAutoResumeTimer);
      this.riskAutoResumeTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    logger.warn("System paused — new positions blocked, existing tracked");
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    this.pausedByRiskGuard = false;
    this.riskPauseTriggeredAt = null;
    this.consecutiveLossCount = 0;
    if (this.riskAutoResumeTimer) {
      clearTimeout(this.riskAutoResumeTimer);
      this.riskAutoResumeTimer = null;
    }

    // Reload portfolio in case an admin wiped and reset it.
    await this.portfolioManager.reload();

    await this.scanner.start();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), 10_000);

    logger.info("System resumed — trading active");
  }

  isPaused(): boolean {
    return this.paused;
  }

  getStats() {
    const config = getConfig();
    const sigmaPerSec = this.btcWatcher.getRealizedVol(
      config.strategy.sigmaWindowMs,
    );
    return {
      running: this.running,
      paused: this.paused,
      activeMarkets: this.activeMarkets.size,
      openPositions: this.openPositions.size,
      cycleCount: this.cycleCount,
      scanner: {
        discoveredCount: this.scanner.getDiscoveredCount(),
      },
      ws: this.wsWatcher.getStats(),
      strategy: this.strategyEngine.getStats(),
      btcConnected: this.btcWatcher.isConnected(),
      btcPrice: this.btcWatcher.getCurrentPrice()?.price ?? null,
      btcPriceAgeMs: this.btcWatcher.getPriceAgeMs(),
      btcPriceFresh: this.btcWatcher.isPriceFresh(),
      sigmaPerSec,
      risk: {
        consecutiveLossCount: this.consecutiveLossCount,
        consecutiveLossPauseLimit: config.strategy.consecutiveLossPauseLimit,
        pausedByRiskGuard: this.pausedByRiskGuard,
        riskPauseTriggeredAt: this.riskPauseTriggeredAt,
      },
    };
  }

  getLiveMarkets() {
    const now = marketNow();
    return Array.from(this.activeMarkets.values())
      .filter((m) => !m.resolved)
      .sort((a, b) => a.endDate.getTime() - b.endDate.getTime())
      .map((m) => {
        const hasPosition = this.hasOpenPositionsForMarket(m.marketId);
        const windowStartMs = m.endDate.getTime() - this.windowDurationMs;
        // UPCOMING: window not yet open · ACTIVE: open · ENDED: awaiting oracle.
        const status: "ACTIVE" | "ENDED" | "UPCOMING" =
          m.endDate.getTime() <= now
            ? "ENDED"
            : windowStartMs <= now
              ? "ACTIVE"
              : "UPCOMING";

        return {
          marketId: m.marketId,
          question: m.question,
          slug: m.slug,
          endDate: m.endDate.toISOString(),
          windowStart: new Date(windowStartMs).toISOString(),
          yesTokenId: m.yesTokenId,
          noTokenId: m.noTokenId,
          prices: { ...m.lastPrices },
          status,
          hasPosition,
          btcPriceAtWindowStart: m.btcPriceAtWindowStart,
        };
      });
  }

  /** Live per-position observables for open trades (mirrors the trade rows). */
  getOpenPositionSnapshots() {
    return Array.from(this.openPositions.values()).map((pos) => ({
      tradeId: pos.tradeId,
      tokenId: pos.tokenId,
      marketId: pos.marketId,
      minPriceDuringPosition: pos.minBid,
      stopLossPrice: pos.entryPrice - getConfig().strategy.stopLossDelta,
    }));
  }

  /** Total cost basis of all open positions (sum of actualCost), not mark-to-market. */
  computeOpenPositionsValue(): number {
    let total = 0;
    for (const pos of this.openPositions.values()) {
      total += pos.actualCost;
    }
    return total;
  }

  private trackPosition(pos: OpenPosition): void {
    this.openPositions.set(pos.tradeId, pos);

    let byMarket = this.positionsByMarket.get(pos.marketId);
    if (!byMarket) {
      byMarket = new Set();
      this.positionsByMarket.set(pos.marketId, byMarket);
    }
    byMarket.add(pos.tradeId);

    let byToken = this.positionsByToken.get(pos.tokenId);
    if (!byToken) {
      byToken = new Set();
      this.positionsByToken.set(pos.tokenId, byToken);
    }
    byToken.add(pos.tradeId);
  }

  private untrackPosition(tradeId: string): void {
    const pos = this.openPositions.get(tradeId);
    if (!pos) return;
    this.openPositions.delete(tradeId);

    const byMarket = this.positionsByMarket.get(pos.marketId);
    if (byMarket) {
      byMarket.delete(tradeId);
      if (byMarket.size === 0) this.positionsByMarket.delete(pos.marketId);
    }

    const byToken = this.positionsByToken.get(pos.tokenId);
    if (byToken) {
      byToken.delete(tradeId);
      if (byToken.size === 0) this.positionsByToken.delete(pos.tokenId);
    }
  }

  private hasOpenPositionsForMarket(marketId: string): boolean {
    const set = this.positionsByMarket.get(marketId);
    return set !== undefined && set.size > 0;
  }

  private registerMarketState(state: ActiveMarketState): void {
    this.activeMarkets.set(state.marketId, state);
    this.tokenToMarket.set(state.yesTokenId, state.marketId);
    this.tokenToMarket.set(state.noTokenId, state.marketId);
    if (state.conditionId) {
      this.conditionIdMap.set(state.conditionId, state.marketId);
    }
  }

  private wireEvents(): void {
    // Scanner → new market discovered
    this.scanner.on("newMarket", async ({ market }) => {
      try {
        await this.onNewMarket(market);
      } catch (err) {
        logger.error(
          { err, marketId: market?.id },
          "Error handling new market",
        );
      }
    });

    this.wsWatcher.on("bookUpdate", (ev: BookUpdateEvent) =>
      this.onBookUpdate(ev),
    );

    this.wsWatcher.on("marketResolved", (ev: MarketResolvedEvent) =>
      this.onMarketResolved(ev),
    );

    this.btcWatcher.on("btcPriceUpdate", () => this.tryFillBtcWindowStart());

    this.strategyEngine.on("opportunityDetected", (opp: MarketOpportunity) => {
      this.onOpportunity(opp).catch((err) => {
        logger.error(
          { err, marketId: opp.marketId },
          "Error handling opportunity",
        );
      });
    });
  }

  /**
   * Fill btcPriceAtWindowStart for any market whose window has opened, preferring
   * a historical lookup and falling back to the current live price (the usual case
   * after a mid-window restart). Waits silently until BTC is connected.
   */
  private tryFillBtcWindowStart(): void {
    if (this.pendingBtcFills.size === 0) return;

    const nowMs = marketNow();

    for (const marketId of this.pendingBtcFills) {
      const state = this.activeMarkets.get(marketId);
      if (!state || state.btcPriceAtWindowStart !== null) {
        this.pendingBtcFills.delete(marketId);
        continue;
      }

      const windowStartMs = state.endDate.getTime() - this.windowDurationMs;
      if (nowMs < windowStartMs) continue;

      let resolved: number | null = null;
      let source: "historical" | "current" = "historical";

      // Skip the historical lookup unless the buffer predates the window start,
      // otherwise getPriceAt() only returns null and logs noise.
      const oldestHistoryMs = this.btcWatcher.getOldestHistoryTimestamp();
      if (oldestHistoryMs !== null && oldestHistoryMs <= windowStartMs) {
        resolved = this.btcWatcher.getPriceAt(windowStartMs);
      }

      if (resolved === null) {
        const current = this.btcWatcher.getCurrentPrice();
        if (current !== null) {
          resolved = current.price;
          source = "current";
        }
      }

      if (resolved === null) continue;

      state.btcPriceAtWindowStart = resolved;
      this.pendingBtcFills.delete(marketId);

      logger.info(
        {
          marketId: state.marketId,
          btcPrice: resolved,
          source,
          ...(source === "current" ? { windowStartMs } : {}),
        },
        source === "current"
          ? "btcPriceAtWindowStart filled (current price — no history covering window start)"
          : "btcPriceAtWindowStart filled (historical)",
      );

      // For relative Up/Down markets the window-start price is the strike.
      if (state.targetPrice === null) {
        state.targetPrice = resolved;
        this.strategyEngine.updateStrike(state.yesTokenId, resolved);
        this.strategyEngine.updateStrike(state.noTokenId, resolved);
      }
    }
  }

  private async onNewMarket(market: any): Promise<void> {
    if (this.paused) return;
    if (this.activeMarkets.has(market.id)) return;

    const tokenIds = PolymarketClient.parseClobTokenIds(market);
    const outcomes = PolymarketClient.parseOutcomes(market);
    const targetPrice = PolymarketClient.parseTargetPrice(market.question);

    if (tokenIds.length < 2 || outcomes.length < 2) {
      logger.warn(
        { marketId: market.id },
        "Market missing token IDs or outcomes",
      );
      return;
    }

    const endDate = market.endDate ? new Date(market.endDate) : new Date();

    // Gamma can return old unresolved markets; skip ones already expired.
    if (endDate.getTime() < marketNow()) {
      logger.debug(
        { marketId: market.id, endDate: endDate.toISOString() },
        "Skipping expired market",
      );
      return;
    }

    // Pre-fill if the window is already open; else the next BTC tick fills it.
    const windowStartMs = endDate.getTime() - this.windowDurationMs;
    const btcPriceAtWindowStart =
      windowStartMs <= marketNow()
        ? (this.btcWatcher.getPriceAt(windowStartMs) ??
          this.btcWatcher.getCurrentPrice()?.price ??
          null)
        : null;

    const state: ActiveMarketState = {
      marketId: market.id,
      conditionId: market.conditionId ?? null,
      yesTokenId: tokenIds[0]!,
      noTokenId: tokenIds[1]!,
      question: market.question ?? "",
      slug: market.slug ?? null,
      endDate,
      targetPrice: targetPrice ?? btcPriceAtWindowStart,
      btcPriceAtWindowStart,
      outcomes,
      lastPrices: {},
      subscribedWs: false,
      resolved: false,
      winningOutcome: null,
      rawMarket: market,
    };

    this.registerMarketState(state);
    if (state.btcPriceAtWindowStart === null) {
      this.pendingBtcFills.add(market.id);
    }

    // effectiveTargetPrice is null for relative Up/Down markets until it's filled.
    const effectiveTargetPrice = targetPrice ?? btcPriceAtWindowStart;
    for (let i = 0; i < tokenIds.length; i++) {
      this.strategyEngine.registerMarket(
        market.id,
        tokenIds[i]!,
        outcomes[i] ?? `Outcome${i}`,
        endDate,
        effectiveTargetPrice,
      );
    }

    this.wsWatcher.subscribe(tokenIds);
    state.subscribedWs = true;

    logger.info(
      {
        marketId: market.id,
        question: market.question,
        endDate: endDate.toISOString(),
        targetPrice,
        tokens: tokenIds.length,
      },
      "New market activated",
    );
  }

  /** Executable state changed: refresh prices, re-evaluate entry, check stops. */
  private onBookUpdate({ tokenId, bestBid, bestAsk }: BookUpdateEvent): void {
    if (bestBid === null || bestAsk === null) return; // one-sided book: not executable

    const marketId = this.tokenToMarket.get(tokenId);
    if (marketId) {
      const state = this.activeMarkets.get(marketId);
      if (state) {
        // Track while the window is live; afterwards freeze until settlement,
        // but still seed once so a restart mid-window isn't left blank.
        const live = state.endDate.getTime() > marketNow();
        if (live || state.lastPrices[tokenId] === undefined) {
          state.lastPrices[tokenId] = { bid: bestBid, ask: bestAsk };
        }
      }
    }

    const config = getConfig();
    this.strategyEngine.evaluatePrice(
      tokenId,
      bestBid,
      bestAsk,
      this.btcWatcher.getCurrentPrice(),
      this.btcWatcher.getRealizedVol(config.strategy.sigmaWindowMs),
    );

    this.trackMinBid(tokenId, bestBid);
    this.checkStopLoss(tokenId, bestBid);
  }

  /** Lowest executable bid seen while a position is open (observational only). */
  private trackMinBid(tokenId: string, bestBid: number): void {
    const tradeIds = this.positionsByToken.get(tokenId);
    if (!tradeIds) return;
    for (const tradeId of tradeIds) {
      const pos = this.openPositions.get(tradeId);
      if (!pos || bestBid >= pos.minBid) continue;
      pos.minBid = bestBid;
      updateTradeMinPrice(tradeId, bestBid.toFixed(6)).catch((err) =>
        logger.debug({ err, tradeId }, "Failed to persist min price"),
      );
    }
  }

  private checkStopLoss(tokenId: string, bestBid: number): void {
    const config = getConfig();
    if (!config.strategy.stopLossEnabled) return;

    const tradeIds = this.positionsByToken.get(tokenId);
    if (!tradeIds) return;

    const now = marketNow();
    for (const tradeId of tradeIds) {
      const pos = this.openPositions.get(tradeId);
      if (!pos || pos.stopTriggered) continue;
      if (pos.marketEndDate.getTime() <= now) continue; // settled at resolution
      if (bestBid > pos.entryPrice - config.strategy.stopLossDelta) continue;

      pos.stopTriggered = true;
      logger.warn(
        {
          tradeId,
          entryPrice: pos.entryPrice.toFixed(4),
          bestBid: bestBid.toFixed(4),
          stopLevel: (pos.entryPrice - config.strategy.stopLossDelta).toFixed(
            4,
          ),
        },
        "Stop-loss breached — submitting market exit",
      );
      this.submitStopLossExit(tradeId, pos, bestBid).catch((err) => {
        logger.error({ err, tradeId }, "Stop-loss exit failed");
        const p = this.openPositions.get(tradeId);
        if (p) p.stopTriggered = false;
      });
    }
  }

  private async onMarketResolved(ev: MarketResolvedEvent): Promise<void> {
    const { conditionId, winningAssetId, winningOutcome } = ev;

    logger.info(
      { conditionId, winningAssetId, winningOutcome },
      "Market resolved via WebSocket",
    );

    const marketId = this.conditionIdMap.get(conditionId);
    if (!marketId) {
      // Fallback to a DB lookup if the in-memory map missed it.
      const db = getDb();
      const [row] = await db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.conditionId, conditionId))
        .limit(1);
      if (!row) return;

      const state = this.activeMarkets.get(row.id);
      if (!state || state.resolved) return;
      state.resolved = true;
      await this.settleMarketPositions(row.id, winningAssetId, winningOutcome);
      return;
    }

    const state = this.activeMarkets.get(marketId);
    if (!state || state.resolved) return;
    state.resolved = true;
    await this.settleMarketPositions(marketId, winningAssetId, winningOutcome);
  }

  /**
   * Fetch the live book, size and simulate a FAK buy against it, enforce the
   * protocol min order size, then deduct cash and persist the resulting trade.
   */
  private async onOpportunity(opp: MarketOpportunity): Promise<void> {
    if (this.paused) return;

    if (this.inFlightTokenIds.has(opp.tokenId)) {
      logger.debug(
        { tokenId: opp.tokenId, marketId: opp.marketId },
        "onOpportunity skipped — already in-flight for this token",
      );
      return;
    }
    this.inFlightTokenIds.add(opp.tokenId);

    const config = getConfig();

    try {
      const orderbook = this.wsWatcher.getBook(opp.tokenId);
      if (!orderbook || orderbook.asks.length === 0) {
        logger.warn(
          { tokenId: opp.tokenId },
          "No executable asks — will retry on next book update",
        );
        this.strategyEngine.clearEvaluated(opp.tokenId);
        return;
      }
      const bestAskPrice =
        this.wsWatcher.getBestAsk(opp.tokenId) ?? opp.bestAsk;

      const openPositionsValue = this.computeOpenPositionsValue();
      const positionBudget =
        this.portfolioManager.computePositionBudget(openPositionsValue);
      const cash = this.portfolioManager.getCashBalance();
      if (cash < positionBudget) {
        logger.info(
          { positionBudget, cash },
          "Insufficient settled cash for position budget — skipping",
        );
        return;
      }

      const execution = simulateLimitBuy(
        orderbook,
        positionBudget,
        config.strategy.maxEntryPrice,
      );

      if (execution.totalShares <= 0) {
        logger.warn(
          {
            tokenId: opp.tokenId,
            maxEntryPrice: config.strategy.maxEntryPrice,
            bestAsk: bestAskPrice,
          },
          "No fill — all asks above maxEntryPrice; will retry",
        );
        this.strategyEngine.clearEvaluated(opp.tokenId);
        return;
      }

      if (execution.belowMinimumOrderSize) {
        logger.warn(
          {
            tokenId: opp.tokenId,
            filled: execution.totalShares,
            minOrderSize: execution.minOrderSize,
          },
          `Rejecting: filled ${execution.totalShares.toFixed(2)} shares < min_order_size ${execution.minOrderSize}`,
        );
        this.strategyEngine.clearEvaluated(opp.tokenId);
        return;
      }

      const expectedProfit = calculateWinProfit(
        execution.averagePrice,
        execution.totalShares,
        execution.fees,
      );

      if (expectedProfit < 0.001) {
        logger.debug(
          { expectedProfit, tokenId: opp.tokenId },
          "Expected profit too small",
        );
        return;
      }

      const actualCost = execution.netCost;
      const deducted = await this.portfolioManager.deductCash(actualCost);
      if (!deducted) {
        logger.warn(
          { actualCost, cash: this.portfolioManager.getCashBalance() },
          "Insufficient cash for actual fill cost — skipping",
        );
        return;
      }

      const fillStatus = execution.isPartialFill ? "PARTIAL" : "FULL";

      const marketState = this.activeMarkets.get(opp.marketId);
      if (marketState && marketState.rawMarket) {
        const tokenIds = PolymarketClient.parseClobTokenIds(
          marketState.rawMarket,
        );
        const outcomes = PolymarketClient.parseOutcomes(marketState.rawMarket);

        await insertMarketIfNew(opp.marketId, {
          conditionId: marketState.conditionId ?? "",
          slug: marketState.slug ?? undefined,
          question: marketState.question ?? undefined,
          clobTokenIds: tokenIds,
          outcomes,
          windowType: config.strategy.marketWindow,
          category: "Crypto",
          endDate: marketState.endDate.toISOString(),
          targetPrice: marketState.targetPrice,
          active: true,
          metadata: marketState.rawMarket,
        });
      }

      const entryTs = new Date(marketNow());
      const tradeRow = await createSimulatedTrade({
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        entryTs,
        windowType: config.strategy.marketWindow,
        entryPrice: execution.averagePrice.toFixed(6),
        entryShares: execution.totalShares.toFixed(6),
        positionBudget: positionBudget.toFixed(6),
        actualCost: actualCost.toFixed(6),
        entryFees: execution.fees.toFixed(6),
        fillStatus,
        btcPriceAtEntry: opp.btcPrice,
        btcTargetPrice: opp.strike,
        btcDistanceUsd: opp.signedDistanceUsd,
        entryZ: opp.z,
        entrySigma: opp.sigmaPerSec,
        secondsToEnd: opp.secondsToEnd,
      });
      const tradeId = tradeRow!.id;

      // Track open position
      const market = this.activeMarkets.get(opp.marketId);
      this.trackPosition({
        tradeId,
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        entryPrice: execution.averagePrice,
        entryShares: execution.totalShares,
        fees: execution.fees,
        actualCost,
        marketEndDate: market?.endDate ?? new Date(),
        minBid:
          this.wsWatcher.getBestBid(opp.tokenId) ?? execution.averagePrice,
      });

      this.scheduleSettlementWatch(opp.marketId);

      await logAudit(
        "info",
        "TRADE_OPENED",
        `Trade ${tradeId} opened for ${opp.outcomeLabel}`,
        {
          tradeId,
          tokenId: opp.tokenId,
          outcome: opp.outcomeLabel,
          avgPrice: execution.averagePrice,
          shares: execution.totalShares,
          positionBudget,
          actualCost,
          expectedProfit,
          btcPrice: opp.btcPrice,
          strike: opp.strike,
          distance: opp.signedDistanceUsd,
          z: opp.z,
          sigmaPerSec: opp.sigmaPerSec,
          secondsToEnd: opp.secondsToEnd,
          cashRemaining: this.portfolioManager.getCashBalance(),
        },
      );

      this.cycleCount++;
      this.emit("tradeOpened", {
        tradeId,
        trade: tradeRow,
        ...opp,
        execution,
        expectedProfit,
      });

      logger.info(
        {
          tradeId,
          marketId: opp.marketId,
          outcome: opp.outcomeLabel,
          avgPrice: execution.averagePrice.toFixed(4),
          shares: execution.totalShares.toFixed(2),
          budget: positionBudget.toFixed(2),
          actualCost: actualCost.toFixed(4),
          fees: execution.fees.toFixed(4),
          expectedProfit: expectedProfit.toFixed(4),
          btcPrice: opp.btcPrice.toFixed(2),
          z: opp.z.toFixed(2),
          distance: opp.signedDistanceUsd.toFixed(2),
          cashRemaining: this.portfolioManager.getCashBalance().toFixed(2),
        },
        "📈 Simulated trade opened",
      );
    } catch (error) {
      logger.error(
        { error, marketId: opp.marketId, tokenId: opp.tokenId },
        "Failed to execute simulated trade",
      );
      logAudit(
        "error",
        "SYSTEM",
        `Failed to execute simulated trade for market ${opp.marketId}: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
    } finally {
      this.inFlightTokenIds.delete(opp.tokenId);
    }
  }

  /**
   * Mirrors a real engine: the order is submitted the moment the trigger is seen,
   * then matched against the book as it stands when the order lands — the book
   * keeps moving during the round-trip, so the fill is not the trigger price.
   */
  private async submitStopLossExit(
    tradeId: string,
    pos: OpenPosition,
    triggerBid: number,
  ): Promise<void> {
    try {
      const config = getConfig();
      await sleep(config.strategy.executionLatencyMs);

      const book = this.wsWatcher.getBook(pos.tokenId);
      if (!book || book.bids.length === 0) {
        // Nothing to match against: keep the position and re-arm the trigger.
        logger.warn({ tradeId }, "Stop-loss unfilled — no executable bids");
        pos.stopTriggered = false;
        return;
      }

      const sell = simulateLimitSell(book, pos.entryShares, 0);
      if (sell.totalSharesSold <= 0) {
        logger.warn({ tradeId }, "Stop-loss unfilled — no matching liquidity");
        pos.stopTriggered = false;
        return;
      }
      if (sell.isPartialFill) {
        logger.warn(
          { tradeId, sold: sell.totalSharesSold, total: pos.entryShares },
          "Stop-loss partial fill — insufficient bid liquidity",
        );
      }
      const exitPrice = sell.averagePrice;
      const exitFees = sell.fees;
      logger.debug(
        {
          tradeId,
          triggerBid: triggerBid.toFixed(4),
          fill: exitPrice.toFixed(4),
          slippage: (triggerBid - exitPrice).toFixed(4),
          latencyMs: config.strategy.executionLatencyMs,
        },
        "Stop-loss order matched",
      );

      const pnl = calculateEarlyExitPnl(
        pos.entryPrice,
        exitPrice,
        pos.entryShares,
        pos.fees,
        exitFees,
      );
      const isWin = pnl > 0;
      const proceeds = pos.entryShares * exitPrice - exitFees;
      if (proceeds > 0) await this.portfolioManager.addCash(proceeds);

      await resolveTrade(
        tradeId,
        isWin ? "WIN" : "LOSS",
        pnl.toFixed(6),
        exitPrice.toFixed(6),
        {
          exitReason: "STOP_LOSS",
        },
      );
      this.updateConsecutiveLossState(isWin);
      this.untrackPosition(tradeId);

      await logAudit(
        "warn",
        "STOP_LOSS",
        `Stop-loss for trade ${tradeId}: exit @ ${exitPrice.toFixed(4)}, PnL ${pnl.toFixed(4)}`,
        {
          tradeId,
          tokenId: pos.tokenId,
          entryPrice: pos.entryPrice,
          exitPrice,
          exitFees,
          pnl,
        },
      );
      logger.info(
        {
          tradeId,
          marketId: pos.marketId,
          entryPrice: pos.entryPrice.toFixed(4),
          exitPrice: exitPrice.toFixed(4),
          pnl: pnl.toFixed(4),
        },
        "🛑 Stop-loss executed",
      );

      this.emit("tradeResolved", {
        tradeId,
        isWin,
        pnl,
        exitPrice,
        trade: null,
      });
    } catch (error) {
      logger.error({ error, tradeId }, "Stop-loss execution error");
      logAudit(
        "error",
        "SYSTEM",
        `Stop-loss error for trade ${tradeId}: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
      const position = this.openPositions.get(tradeId);
      if (position) position.stopTriggered = false;
    }
  }
  private scheduleSettlementWatch(marketId: string): void {
    if (this.resolutionTimers.has(marketId)) return;

    const FAST_INTERVAL = 5_000;
    const SLOW_INTERVAL = 30_000;
    const FAST_PHASE_MS = 2 * 60_000;
    const startTime = Date.now();

    const stop = () => {
      const t = this.resolutionTimers.get(marketId);
      if (t) clearTimeout(t);
      this.resolutionTimers.delete(marketId);
    };

    const poll = async () => {
      if (!this.running || !this.hasOpenPositionsForMarket(marketId)) {
        stop();
        return;
      }
      await this.pollSettlement(marketId);
      if (!this.hasOpenPositionsForMarket(marketId)) {
        stop();
        return;
      }
      const elapsed = Date.now() - startTime;
      const interval = elapsed < FAST_PHASE_MS ? FAST_INTERVAL : SLOW_INTERVAL;
      timerId = setTimeout(poll, interval);
      this.resolutionTimers.set(marketId, timerId);
    };

    let timerId = setTimeout(poll, FAST_INTERVAL);
    this.resolutionTimers.set(marketId, timerId);
  }
  private async pollSettlement(marketId: string): Promise<void> {
    const RESOLVE_THRESHOLD = 0.99;
    try {
      const market = await this.client.getMarketById(marketId);
      if (!market) return;

      const outcomes = PolymarketClient.parseOutcomes(market);
      const prices = PolymarketClient.parseOutcomePrices(market);
      const tokenIds = PolymarketClient.parseClobTokenIds(market);

      const winIdx = prices.findIndex((p) => p >= RESOLVE_THRESHOLD);
      if (winIdx < 0) return; // not yet decisive — poll again

      const winningTokenId = tokenIds[winIdx];
      const winningOutcome = outcomes[winIdx];
      if (!winningTokenId || !winningOutcome) return;

      const state = this.activeMarkets.get(marketId);
      if (state) state.resolved = true;
      await this.settleMarketPositions(
        marketId,
        winningTokenId,
        winningOutcome,
      );
    } catch (error) {
      logger.error({ error, marketId }, "Settlement poll failed");
      logAudit(
        "error",
        "SYSTEM",
        `Settlement poll failed for market ${marketId}: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
    }
  }
  private async settleMarketPositions(
    marketId: string,
    winningTokenId: string,
    winningOutcome: string,
  ): Promise<void> {
    const marketState = this.activeMarkets.get(marketId);
    if (marketState) marketState.winningOutcome = winningOutcome;

    for (const [tradeId, pos] of this.openPositions) {
      if (pos.marketId !== marketId) continue;

      const isWin = pos.tokenId === winningTokenId;
      const redemption = isWin ? pos.entryShares : 0;
      const pnl = redemption - pos.actualCost;
      if (redemption > 0) await this.portfolioManager.addCash(redemption);

      const resolvedTrade = await resolveTrade(
        tradeId,
        isWin ? "WIN" : "LOSS",
        pnl.toFixed(6),
        (isWin ? 1 : 0).toFixed(6),
        { exitReason: "RESOLUTION" },
      );
      this.updateConsecutiveLossState(isWin);
      this.untrackPosition(tradeId);

      await logAudit(
        "info",
        "TRADE_RESOLVED",
        `Trade ${tradeId} resolved: ${isWin ? "WIN" : "LOSS"} (${winningOutcome})`,
        {
          tradeId,
          outcome: isWin ? "WIN" : "LOSS",
          pnl,
          winningOutcome,
          cashBalance: this.portfolioManager.getCashBalance(),
        },
      );
      logger.info(
        {
          tradeId,
          marketId,
          outcome: isWin ? "WIN" : "LOSS",
          pnl: pnl.toFixed(4),
        },
        isWin ? "✅ Trade WON" : "❌ Trade LOST",
      );

      this.emit("tradeResolved", {
        tradeId,
        isWin,
        pnl,
        exitPrice: isWin ? 1 : 0,
        trade: resolvedTrade,
      });
    }

    if (!this.hasOpenPositionsForMarket(marketId)) {
      this.cleanupMarket(marketId);
    }
  }

  private updateConsecutiveLossState(isWin: boolean): void {
    const config = getConfig();
    const limit = config.strategy.consecutiveLossPauseLimit;
    if (limit <= 0) return;

    if (isWin) {
      this.consecutiveLossCount = 0;
      return;
    }

    this.consecutiveLossCount++;

    if (this.consecutiveLossCount < limit) return;
    if (this.paused) return;

    this.pausedByRiskGuard = true;
    this.riskPauseTriggeredAt = Date.now();
    this.pause();

    logAudit(
      "error",
      "RISK_GUARD",
      `Auto-paused after ${this.consecutiveLossCount} consecutive losses`,
      {
        consecutiveLossCount: this.consecutiveLossCount,
        pauseLimit: limit,
        cashBalance: this.portfolioManager.getCashBalance(),
      },
    ).catch(() => {});

    logger.error(
      {
        consecutiveLossCount: this.consecutiveLossCount,
        pauseLimit: limit,
      },
      "🛑 Risk guard triggered — system auto-paused",
    );

    if (config.strategy.riskAutoResumeEnabled) {
      if (this.riskAutoResumeTimer) {
        clearTimeout(this.riskAutoResumeTimer);
      }
      this.riskAutoResumeTimer = setTimeout(() => {
        this.resume()
          .then(() => {
            this.consecutiveLossCount = 0;
            this.pausedByRiskGuard = false;
            this.riskPauseTriggeredAt = null;
            this.riskAutoResumeTimer = null;
            logger.warn("Risk guard auto-resume executed");
          })
          .catch((err) =>
            logger.error({ err }, "Risk guard auto-resume failed"),
          );
      }, config.strategy.riskAutoResumeCooldownMs);
    }
  }

  private async loadOpenPositions(): Promise<void> {
    const rows = await loadOpenTradesWithMarkets();

    for (const { trade, marketEndDate } of rows) {
      this.trackPosition({
        tradeId: trade.id,
        marketId: trade.marketId ?? "",
        tokenId: trade.tokenId ?? "",
        outcomeLabel: trade.outcomeLabel ?? "",
        entryPrice: parseFloat(trade.entryPrice),
        entryShares: parseFloat(trade.entryShares),
        fees: parseFloat(trade.entryFees ?? "0"),
        actualCost: parseFloat(trade.actualCost ?? "0"),
        marketEndDate: marketEndDate ? new Date(marketEndDate) : new Date(),
        minBid: parseFloat(trade.minPriceDuringPosition ?? trade.entryPrice),
      });

      if (trade.marketId) this.scheduleSettlementWatch(trade.marketId);
    }

    if (rows.length > 0) {
      logger.info(
        { count: rows.length },
        "Loaded existing open positions from database",
      );
    }
  }

  /**
   * Load active markets for the current window from the DB on startup, keeping
   * only those still in the future or recently past with open positions.
   */
  private async loadActiveMarkets(): Promise<void> {
    const config = getConfig();
    const db = getDb();

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const marketRows = await db
      .select()
      .from(schema.markets)
      .where(
        and(
          eq(schema.markets.active, true),
          eq(schema.markets.windowType, config.strategy.marketWindow),
          gte(schema.markets.endDate, cutoff.toISOString()),
        ),
      )
      .orderBy(desc(schema.markets.endDate))
      .limit(50);

    for (const row of marketRows) {
      if (this.activeMarkets.has(row.id)) continue;

      const tokenIds = row.clobTokenIds as string[] | null;
      const outcomes = row.outcomes as string[] | null;

      if (
        !tokenIds ||
        tokenIds.length < 2 ||
        !outcomes ||
        outcomes.length < 2
      ) {
        logger.warn(
          { marketId: row.id },
          "Skipping market with invalid token IDs or outcomes",
        );
        continue;
      }

      const endDate = row.endDate ? new Date(row.endDate) : new Date();
      const targetPrice = row.targetPrice ? parseFloat(row.targetPrice) : null;

      const hasOpenPositions = this.hasOpenPositionsForMarket(row.id);

      // Drop markets that ended over 30 min ago with no open positions.
      const thirtyMinutesAgo = marketNow() - 30 * 60 * 1000;
      if (endDate.getTime() < thirtyMinutesAgo && !hasOpenPositions) {
        continue;
      }

      const state: ActiveMarketState = {
        marketId: row.id,
        conditionId: row.conditionId ?? null,
        yesTokenId: tokenIds[0]!,
        noTokenId: tokenIds[1]!,
        question: row.question ?? "",
        slug: row.slug ?? null,
        endDate,
        targetPrice,
        btcPriceAtWindowStart: null,
        outcomes,
        lastPrices: {},
        subscribedWs: false,
        resolved: false,
        winningOutcome: null,
        rawMarket: row.metadata,
      };

      this.registerMarketState(state);
      this.pendingBtcFills.add(row.id);

      const effectiveTargetPrice = targetPrice ?? null;
      for (let i = 0; i < tokenIds.length; i++) {
        this.strategyEngine.registerMarket(
          row.id,
          tokenIds[i]!,
          outcomes[i] ?? `Outcome${i}`,
          endDate,
          effectiveTargetPrice,
        );
      }

      this.wsWatcher.subscribe(tokenIds);
      state.subscribedWs = true;

      logger.info(
        {
          marketId: row.id,
          question: row.question,
          endDate: endDate.toISOString(),
          hasOpenPositions,
        },
        "Loaded existing active market from database",
      );
    }

    if (marketRows.length > 0) {
      logger.info(
        { count: marketRows.length, active: this.activeMarkets.size },
        "Loaded existing active markets from database",
      );
    }
  }

  /** Raw GammaMarkets for active markets, for API merging. */
  getRawActiveMarkets(): any[] {
    return Array.from(this.activeMarkets.values())
      .map((state) => state.rawMarket)
      .filter(Boolean);
  }

  /** Remove expired markets with no open positions; kept otherwise until resolved. */
  private cleanupExpiredMarkets(): void {
    const now = marketNow();
    const toClean: string[] = [];

    for (const [marketId, state] of this.activeMarkets) {
      if (state.resolved) {
        toClean.push(marketId);
        continue;
      }
      if (state.endDate.getTime() > now) continue;
      if (this.hasOpenPositionsForMarket(marketId)) continue;
      toClean.push(marketId);
    }

    for (const marketId of toClean) {
      this.cleanupMarket(marketId);
    }

    if (toClean.length > 0) {
      logger.debug(
        { cleaned: toClean.length, remaining: this.activeMarkets.size },
        "Cleaned up expired markets",
      );
    }
  }

  private cleanupMarket(marketId: string): void {
    const state = this.activeMarkets.get(marketId);
    if (!state) return;

    // Never clean up a market that still has open positions.
    if (this.hasOpenPositionsForMarket(marketId)) return;

    recordCompletedMarket(
      {
        marketId,
        slug: state.slug,
        windowType: getConfig().strategy.marketWindow,
        windowStart: new Date(state.endDate.getTime() - this.windowDurationMs),
        windowEnd: state.endDate,
        btcStartPrice: state.btcPriceAtWindowStart,
        winningOutcome: state.winningOutcome,
      },
      this.btcWatcher,
    ).catch((err) =>
      logger.error({ err, marketId }, "Failed to record market window data"),
    );

    if (state.subscribedWs) {
      this.wsWatcher.unsubscribe([state.yesTokenId, state.noTokenId]);
    }

    this.strategyEngine.unregisterMarket(state.yesTokenId);
    this.strategyEngine.unregisterMarket(state.noTokenId);

    if (state.conditionId) {
      this.conditionIdMap.delete(state.conditionId);
    }

    this.tokenToMarket.delete(state.yesTokenId);
    this.tokenToMarket.delete(state.noTokenId);

    this.activeMarkets.delete(marketId);
  }
}

let instance: MarketOrchestrator | null = null;
export function getMarketOrchestrator(): MarketOrchestrator {
  if (!instance) instance = new MarketOrchestrator();
  return instance;
}
