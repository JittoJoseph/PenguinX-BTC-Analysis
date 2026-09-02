import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { WINDOW_CONFIG, FIXED_POSITION_BUDGET_USD } from "../types/index.js";
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
  type Evaluation,
} from "./strategy-engine.js";
import { forecastSettlement, rollingOutRange } from "./settlement-model.js";
import {
  simulateLimitBuy,
  simulateLimitSell,
  calculateWinProfit,
  stopTriggerPrice,
} from "./execution-simulator.js";
import { getBtcPriceWatcher, BtcPriceWatcher } from "./btc-price-watcher.js";
import { marketNow } from "./market-clock.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";
import { PortfolioManager } from "./portfolio-manager.js";

import type {
  BookUpdateEvent,
  MarketResolvedEvent,
  BtcPriceData,
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
  lastEvaluations: Record<string, Evaluation>;
  subscribedWs: boolean;
  resolved: boolean;
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
  /** Shares still held. A stop that only partly fills leaves a remainder. */
  remainingShares: number;
  /** Gross USD taken from stop sales so far, and the fees paid on them. */
  exitGross: number;
  exitFees: number;
  stopTriggered: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number, dp = 4) => Math.round(v * 10 ** dp) / 10 ** dp;

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
  private resolutionTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly windowDurationMs = WINDOW_CONFIG.durationMs;

  private running = false;
  private paused = false;
  private cycleCount = 0;

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

    await this.portfolioManager.init();

    logger.info(
      {
        label: WINDOW_CONFIG.label,
        twapLookbackSeconds: WINDOW_CONFIG.twapLookbackSeconds,
        entryWindowSec: `${config.strategy.entryWindowCloseSeconds}-${config.strategy.entryWindowOpenSeconds}`,
        minModelEdge: config.strategy.minModelEdge,
        minSettlementSigmas: config.strategy.minSettlementSigmas,
        positionBudgetUsd: FIXED_POSITION_BUDGET_USD,
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

    this.stopCleanupTimer();
    this.clearResolutionTimers();

    logger.info("Market orchestrator stopped");
  }

  /** Pause new entries; open positions stay tracked and the WS stays alive. */
  pause(): void {
    this.paused = true;
    this.scanner.stop();
    this.stopCleanupTimer();

    logger.warn("System paused — new positions blocked, existing tracked");
  }

  private stopCleanupTimer(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private clearResolutionTimers(): void {
    for (const [, timer] of this.resolutionTimers) clearTimeout(timer);
    this.resolutionTimers.clear();
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;

    // Cash can move while paused: positions opened earlier still settle. The
    // manager keeps memory and database in step, so this only matters when the
    // row changed underneath us, which is exactly what a wipe does.
    await this.portfolioManager.reload();

    await this.scanner.start();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), 10_000);

    logger.info("System resumed — trading active");
  }

  /**
   * Drop all in-memory trading state so the process matches an empty database.
   *
   * A wipe deletes the trade rows but the orchestrator would otherwise keep
   * holding the positions they described. Those orphans still settle, and
   * settling one credits cash against a balance that no longer exists, which
   * silently corrupts the fresh portfolio. Everything tied to the old session
   * has to go at the same moment the rows do.
   *
   * Markets are not re-fetched here. The scanner rediscovers them on resume,
   * and because the price buffer survives, a window whose open is still in the
   * buffer gets its strike back — something a process restart would lose.
   */
  resetSessionState(): void {
    this.clearResolutionTimers();

    const subscribed = [...this.tokenToMarket.keys()];
    if (subscribed.length > 0) this.wsWatcher.unsubscribe(subscribed);

    this.openPositions.clear();
    this.positionsByMarket.clear();
    this.positionsByToken.clear();
    this.inFlightTokenIds.clear();
    this.activeMarkets.clear();
    this.conditionIdMap.clear();
    this.tokenToMarket.clear();
    this.pendingBtcFills.clear();
    this.cycleCount = 0;

    this.scanner.reset();
    this.strategyEngine.reset();

    logger.warn(
      { unsubscribedTokens: subscribed.length },
      "Session state cleared",
    );
  }

  isPaused(): boolean {
    return this.paused;
  }

  getStats() {
    const config = getConfig();
    const rawSigma = this.btcWatcher.getRawSigma(config.strategy.sigmaWindowMs);
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
      btcPrice: this.btcWatcher.getCurrentTwap()?.price ?? null,
      btcRawPrice: this.btcWatcher.getCurrentRaw()?.price ?? null,
      btcPriceAgeMs: this.btcWatcher.getTwapAgeMs(),
      btcRawAgeMs: this.btcWatcher.getRawAgeMs(),
      btcPriceFresh: this.btcWatcher.isPriceFresh(),
      rawSigma,
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
      stopLossPrice: stopTriggerPrice(pos.entryPrice, getConfig().strategy.stopLossFraction),
      remainingShares: pos.remainingShares,
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

    this.btcWatcher.on("twapUpdate", (tick: BtcPriceData) => {
      this.tryFillBtcWindowStart();
      this.evaluateActiveMarkets(tick);
    });

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
   * Set the strike for any market whose window has opened. The strike is the
   * settlement TWAP observed at the window open and nothing else, so a market
   * whose open we did not see stays unstruck and untradeable.
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

      const price = this.btcWatcher.getTwapAt(windowStartMs);
      if (price === null) continue;

      state.btcPriceAtWindowStart = price;
      this.pendingBtcFills.delete(marketId);

      if (state.targetPrice === null) {
        state.targetPrice = price;
        this.strategyEngine.updateStrike(state.yesTokenId, price);
        this.strategyEngine.updateStrike(state.noTokenId, price);
      }

      logger.info(
        { marketId, btcPriceAtWindowStart: price },
        "Window start price set",
      );
    }
  }

  private async onNewMarket(market: any): Promise<void> {
    if (this.paused) return;
    if (this.activeMarkets.has(market.id)) return;

    const tokenIds = PolymarketClient.parseClobTokenIds(market);
    const outcomes = PolymarketClient.parseOutcomes(market);
    // The strike is the window-open TWAP and nothing else, so it starts unset
    // and is filled by tryFillBtcWindowStart once that observation arrives.
    const targetPrice = null;

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

    const state: ActiveMarketState = {
      marketId: market.id,
      conditionId: market.conditionId ?? null,
      yesTokenId: tokenIds[0]!,
      noTokenId: tokenIds[1]!,
      question: market.question ?? "",
      slug: market.slug ?? null,
      endDate,
      targetPrice,
      btcPriceAtWindowStart: null,
      outcomes,
      lastPrices: {},
      lastEvaluations: {},
      subscribedWs: false,
      resolved: false,
      rawMarket: market,
    };

    this.registerMarketState(state);
    this.pendingBtcFills.add(market.id);

    for (let i = 0; i < tokenIds.length; i++) {
      this.strategyEngine.registerMarket(
        market.id,
        tokenIds[i]!,
        outcomes[i] ?? `Outcome${i}`,
        endDate,
        targetPrice,
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

    this.strategyEngine.updateQuote(tokenId, bestBid, bestAsk);

    this.trackMinBid(tokenId, bestBid);
    this.checkStopLoss(tokenId, bestBid);
  }

  /**
   * Score every live market on each settlement tick. Driving evaluation off the
   * price feed rather than off book updates keeps the cadence steady: the model
   * changes every second whether or not anyone quotes.
   */
  private evaluateActiveMarkets(tick: BtcPriceData): void {
    if (this.paused) return;

    const config = getConfig();
    if (this.btcWatcher.getRawAgeMs() > config.strategy.maxRawStalenessMs) return;

    const rawSigma = this.btcWatcher.getRawSigma(config.strategy.sigmaWindowMs);
    if (rawSigma === null || rawSigma <= 0) return;

    // Spot must be read at the TWAP's own observation time. Both feeds lag by
    // about two seconds, and pairing a fresher spot with an older TWAP breaks
    // the identity the forecast rests on.
    const anchorMs = tick.timestamp;
    const rawAtAnchor = this.btcWatcher.getRawAt(anchorMs);
    if (rawAtAnchor === null) return;

    for (const state of this.activeMarkets.values()) {
      if (state.resolved || state.targetPrice === null) continue;

      const endMs = state.endDate.getTime();
      const secondsToEnd = (endMs - marketNow()) / 1000;
      if (
        secondsToEnd > config.strategy.entryWindowOpenSeconds ||
        secondsToEnd < config.strategy.entryWindowCloseSeconds
      ) {
        continue;
      }

      const { fromMs, toMs } = rollingOutRange(anchorMs, endMs);
      const rollingOutMean = this.btcWatcher.getRawMean(fromMs, toMs);
      if (rollingOutMean === null) continue;

      const forecast = forecastSettlement({
        anchorMs,
        endMs,
        strike: state.targetPrice,
        twapNow: tick.price,
        rawNow: rawAtAnchor,
        rollingOutMean,
        rawSigma,
      });
      if (!forecast) continue;

      for (const tokenId of [state.yesTokenId, state.noTokenId]) {
        const evaluation = this.strategyEngine.evaluate(tokenId, forecast);
        if (evaluation) this.recordEvaluation(state, evaluation);
      }
    }
  }

  /**
   * Keep the last decision per market, taken or skipped, so the no-trade cases
   * form a baseline. Without them there is no way to tell a working filter from
   * one that simply never fires.
   */
  private recordEvaluation(state: ActiveMarketState, evaluation: Evaluation): void {
    if (evaluation.skipReason === "outside_entry_window") return;
    state.lastEvaluations[evaluation.tokenId] = evaluation;
  }

  /** Lowest executable bid seen while a position is open (observational only). */
  private trackMinBid(tokenId: string, bestBid: number): void {
    const tradeIds = this.positionsByToken.get(tokenId);
    if (!tradeIds) return;
    const now = marketNow();
    for (const tradeId of tradeIds) {
      const pos = this.openPositions.get(tradeId);
      if (!pos || bestBid >= pos.minBid) continue;
      // The same cutoff the stop uses. Past the window end the book is thin and
      // meaningless, and recording it would put values below the stop level on
      // trades the stop could never have fired for.
      if (pos.marketEndDate.getTime() <= now) continue;
      pos.minBid = bestBid;
      updateTradeMinPrice(tradeId, bestBid.toFixed(6)).catch((err) =>
        logger.debug({ err, tradeId }, "Failed to persist min price"),
      );
    }
  }

  private checkStopLoss(tokenId: string, bestBid: number): void {
    const tradeIds = this.positionsByToken.get(tokenId);
    if (!tradeIds) return;

    const now = marketNow();
    for (const tradeId of tradeIds) {
      const pos = this.openPositions.get(tradeId);
      if (!pos || pos.stopTriggered) continue;
      if (pos.marketEndDate.getTime() <= now) continue; // settled at resolution

      const stopPrice = stopTriggerPrice(pos.entryPrice, getConfig().strategy.stopLossFraction);
      if (bestBid > stopPrice) continue;

      pos.stopTriggered = true;
      logger.warn(
        {
          tradeId,
          entryPrice: pos.entryPrice.toFixed(4),
          bestBid: bestBid.toFixed(4),
          stopLevel: stopPrice.toFixed(4),
        },
        "Stop-loss breached — submitting market exit",
      );
      this.submitStopLossExit(tradeId, pos).catch((err) => {
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
        this.strategyEngine.releaseMarket(opp.marketId);
        return;
      }
      const bestAskPrice =
        this.wsWatcher.getBestAsk(opp.tokenId) ?? opp.bestAsk;
      const entryBid = this.wsWatcher.getBestBid(opp.tokenId) ?? opp.bestBid;

      const positionBudget = FIXED_POSITION_BUDGET_USD;

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
        this.strategyEngine.releaseMarket(opp.marketId);
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
        this.strategyEngine.releaseMarket(opp.marketId);
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

      // Last check before any money moves: a wipe or pause can land while the
      // book lookup and sizing above are running.
      if (this.paused) {
        this.strategyEngine.releaseMarket(opp.marketId);
        return;
      }

      const actualCost = execution.netCost;
      await this.portfolioManager.deductCash(actualCost);

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
          windowType: WINDOW_CONFIG.category,
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
        windowType: WINDOW_CONFIG.category,
        entryPrice: execution.averagePrice.toFixed(6),
        entryShares: execution.totalShares.toFixed(6),
        positionBudget: positionBudget.toFixed(6),
        actualCost: actualCost.toFixed(6),
        entryFees: execution.fees.toFixed(6),
        fillStatus,
        twapAtEntry: opp.forecast.twapNow,
        rawAtEntry: opp.forecast.rawNow,
        strike: opp.strike,
        forecastSettlement: opp.forecast.expected,
        forecastMarginUsd: opp.forecast.margin,
        forecastSdUsd: opp.forecast.sd,
        modelProb: opp.modelProb,
        modelEdge: opp.edge,
        secondsToEnd: opp.secondsToEnd,
        minPriceDuringPosition: entryBid.toFixed(6),
      });
      const tradeId = tradeRow!.id;

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
        minBid: entryBid,
        remainingShares: execution.totalShares,
        exitGross: 0,
        exitFees: 0,
        stopTriggered: false,
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
          strike: opp.strike,
          twapNow: opp.forecast.twapNow,
          rawNow: opp.forecast.rawNow,
          forecastSettlement: opp.forecast.expected,
          forecastMargin: opp.forecast.margin,
          forecastSd: opp.forecast.sd,
          modelProb: opp.modelProb,
          modelEdge: opp.edge,
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
          modelProb: opp.modelProb.toFixed(3),
          edge: opp.edge.toFixed(3),
          margin: opp.forecast.margin.toFixed(2),
          sd: opp.forecast.sd.toFixed(2),
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
   * The trigger only decides when to sell. The fill is whatever the bid side
   * holds once the order lands, walked to the bottom of the book with no limit,
   * so a collapsed book produces a near-total loss rather than a tidy exit.
   */
  private async submitStopLossExit(
    tradeId: string,
    pos: OpenPosition,
  ): Promise<void> {
    try {
      const config = getConfig();
      await sleep(config.strategy.executionLatencyMs);

      // The window can resolve while the order is in flight. Settlement will
      // have already paid out and closed the row, so selling now would book the
      // proceeds twice.
      if (!this.openPositions.has(tradeId)) return;

      const book = this.wsWatcher.getBook(pos.tokenId);
      const sell = book
        ? simulateLimitSell(book, pos.remainingShares, 0)
        : null;

      if (!sell || sell.totalSharesSold <= 0) {
        // Nothing on the bid side to hit. Re-arm and try again on the next tick.
        logger.warn({ tradeId }, "Stop-loss unfilled — no executable bids");
        pos.stopTriggered = false;
        return;
      }

      pos.remainingShares -= sell.totalSharesSold;
      pos.exitGross += sell.totalRevenue;
      pos.exitFees += sell.fees;
      const proceeds = sell.totalRevenue - sell.fees;
      if (proceeds > 0) await this.portfolioManager.addCash(proceeds);

      // A book too thin to absorb the whole position leaves a remainder. It
      // stays open and the trigger re-arms, so the rest is sold as liquidity
      // returns, or redeemed at settlement if the window closes first.
      if (pos.remainingShares > 1e-6) {
        pos.stopTriggered = false;
        logger.warn(
          {
            tradeId,
            sold: sell.totalSharesSold.toFixed(4),
            remaining: pos.remainingShares.toFixed(4),
            fill: sell.averagePrice.toFixed(4),
          },
          "Stop-loss partially filled — remainder still open",
        );
        return;
      }

      await this.closeStoppedPosition(tradeId, pos);
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

  /** Write the trade row once a stopped position is fully out of the book. */
  private async closeStoppedPosition(
    tradeId: string,
    pos: OpenPosition,
  ): Promise<void> {
    const exitPrice = pos.exitGross / pos.entryShares;
    const pnl = pos.exitGross - pos.exitFees - pos.actualCost;
    const isWin = pnl > 0;

    await resolveTrade(
      tradeId,
      isWin ? "WIN" : "LOSS",
      pnl.toFixed(6),
      exitPrice.toFixed(6),
      { exitReason: "STOP_LOSS" },
    );
    this.untrackPosition(tradeId);

    await logAudit(
      "warn",
      "STOP_LOSS",
      `Stop-loss for trade ${tradeId}: exit @ ${exitPrice.toFixed(4)}, PnL ${pnl.toFixed(4)}`,
      {
        tradeId,
        tokenId: pos.tokenId,
        entryPrice: pos.entryPrice,
        stopLevel: stopTriggerPrice(pos.entryPrice, getConfig().strategy.stopLossFraction),
        exitPrice,
        exitFees: pos.exitFees,
        pnl,
        lossFraction: pnl < 0 ? -pnl / pos.actualCost : 0,
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

    this.emit("tradeResolved", { tradeId, isWin, pnl, exitPrice, trade: null });
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
    for (const [tradeId, pos] of this.openPositions) {
      if (pos.marketId !== marketId) continue;
      // A wipe can land between iterations. Anything it cleared is gone.
      if (!this.openPositions.has(tradeId)) continue;

      const isWin = pos.tokenId === winningTokenId;
      // Only what we still hold redeems; a partial stop already banked the rest.
      const redemption = isWin ? pos.remainingShares : 0;
      const pnl = pos.exitGross - pos.exitFees + redemption - pos.actualCost;
      if (redemption > 0) await this.portfolioManager.addCash(redemption);

      const partiallyStopped = pos.exitGross > 0;
      const resolvedTrade = await resolveTrade(
        tradeId,
        pnl > 0 ? "WIN" : "LOSS",
        pnl.toFixed(6),
        ((pos.exitGross + redemption) / pos.entryShares).toFixed(6),
        { exitReason: partiallyStopped ? "STOP_LOSS" : "RESOLUTION" },
      );
      this.untrackPosition(tradeId);

      await logAudit(
        "info",
        "TRADE_RESOLVED",
        `Trade ${tradeId} resolved: ${pnl > 0 ? "WIN" : "LOSS"} (${winningOutcome})`,
        {
          tradeId,
          outcome: pnl > 0 ? "WIN" : "LOSS",
          pnl,
          winningOutcome,
          sharesRedeemed: pos.remainingShares,
          stopProceeds: pos.exitGross - pos.exitFees,
          cashBalance: this.portfolioManager.getCashBalance(),
        },
      );
      logger.info(
        {
          tradeId,
          marketId,
          outcome: pnl > 0 ? "WIN" : "LOSS",
          pnl: pnl.toFixed(4),
        },
        pnl > 0 ? "✅ Trade WON" : "❌ Trade LOST",
      );

      this.emit("tradeResolved", {
        tradeId,
        isWin: pnl > 0,
        pnl,
        exitPrice: (pos.exitGross + redemption) / pos.entryShares,
        trade: resolvedTrade,
      });
    }

    if (!this.hasOpenPositionsForMarket(marketId)) {
      this.cleanupMarket(marketId);
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
        remainingShares: parseFloat(trade.entryShares),
        exitGross: 0,
        exitFees: 0,
        stopTriggered: false,
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
          eq(schema.markets.windowType, WINDOW_CONFIG.category),
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
        btcPriceAtWindowStart: targetPrice,
        outcomes,
        lastPrices: {},
        lastEvaluations: {},
        subscribedWs: false,
        resolved: false,
        rawMarket: row.metadata,
      };

      this.registerMarketState(state);
      // A strike restored from a previous run is already the window-open TWAP.
      // Only a market without one still needs filling, and after a restart the
      // buffer will not reach back that far, so it simply stays untradeable.
      if (targetPrice === null) this.pendingBtcFills.add(row.id);

      for (let i = 0; i < tokenIds.length; i++) {
        this.strategyEngine.registerMarket(
          row.id,
          tokenIds[i]!,
          outcomes[i] ?? `Outcome${i}`,
          endDate,
          targetPrice,
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

    this.flushEvaluations(state);

    if (state.subscribedWs) {
      this.wsWatcher.unsubscribe([state.yesTokenId, state.noTokenId]);
    }

    this.strategyEngine.unregisterMarket(state.yesTokenId);
    this.strategyEngine.unregisterMarket(state.noTokenId);
    this.strategyEngine.releaseMarket(marketId);

    if (state.conditionId) {
      this.conditionIdMap.delete(state.conditionId);
    }

    this.tokenToMarket.delete(state.yesTokenId);
    this.tokenToMarket.delete(state.noTokenId);

    this.activeMarkets.delete(marketId);
  }

  /**
   * Write the closest-to-expiry decision for each side once the window is done.
   * Fire-and-forget: nothing about market cleanup should wait on a database
   * round trip.
   */
  private flushEvaluations(state: ActiveMarketState): void {
    const entries = Object.values(state.lastEvaluations);
    if (entries.length === 0) return;

    const best = entries.reduce((a, b) => (b.edge > a.edge ? b : a));
    logAudit(
      "info",
      "EVALUATION",
      `Window ${state.slug ?? state.marketId} closed: ${best.skipReason ?? "traded"}`,
      {
        marketId: state.marketId,
        slug: state.slug,
        windowEnd: state.endDate.toISOString(),
        strike: state.targetPrice,
        sides: entries.map((e) => ({
          outcome: e.outcomeLabel,
          ask: round(e.bestAsk),
          modelProb: round(e.modelProb),
          edge: round(e.edge),
          margin: round(e.forecast.margin, 2),
          sd: round(e.forecast.sd, 2),
          sigmas: round(e.forecast.sigmas, 2),
          secondsToEnd: round(e.forecast.secondsToEnd, 1),
          skipReason: e.skipReason,
        })),
      },
    ).catch((err) =>
      logger.error({ err, marketId: state.marketId }, "Failed to log evaluation"),
    );
  }
}

let instance: MarketOrchestrator | null = null;
export function getMarketOrchestrator(): MarketOrchestrator {
  if (!instance) instance = new MarketOrchestrator();
  return instance;
}
