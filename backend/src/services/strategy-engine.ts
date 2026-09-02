import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { marketNow } from "./market-clock.js";
import type { SettlementForecast } from "./settlement-model.js";

const logger = createModuleLogger("strategy-engine");

export interface MarketOpportunity {
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  bestAsk: number;
  bestBid: number;
  strike: number;
  forecast: SettlementForecast;
  /** Model probability for the side being bought. */
  modelProb: number;
  /** modelProb minus the ask actually paid. */
  edge: number;
  secondsToEnd: number;
}

export type SkipReason =
  | "outside_entry_window"
  | "no_strike"
  | "no_forecast"
  | "quote_missing"
  | "price_band"
  | "weak_margin"
  | "insufficient_edge";

export interface Evaluation {
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  bestAsk: number;
  modelProb: number;
  edge: number;
  forecast: SettlementForecast;
  skipReason: SkipReason | null;
}

interface TokenPriceState {
  bestBid: number;
  bestAsk: number;
  lastUpdate: number;
}

interface WatchedMarket {
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  endDate: Date;
  strike: number | null;
}

/**
 * Buys the side whose settlement-TWAP forecast disagrees with the book.
 *
 * The forecast leans on structure rather than on a view of where BTC is going:
 * inside the final minute the closing 60-second TWAP is largely fixed already,
 * so its expected value and its remaining uncertainty are both computable. When
 * that lands far enough from what the book charges, the difference is the trade.
 */
export class StrategyEngine extends EventEmitter {
  private priceStates: Map<string, TokenPriceState> = new Map();
  private watchedMarkets: Map<string, WatchedMarket> = new Map();
  private tradedMarkets: Set<string> = new Set();
  private triggersCount = 0;

  registerMarket(
    marketId: string,
    tokenId: string,
    outcomeLabel: string,
    endDate: Date,
    strike: number | null,
  ): void {
    this.watchedMarkets.set(tokenId, { marketId, tokenId, outcomeLabel, endDate, strike });
  }

  unregisterMarket(tokenId: string): void {
    this.watchedMarkets.delete(tokenId);
    this.priceStates.delete(tokenId);
  }

  releaseMarket(marketId: string): void {
    this.tradedMarkets.delete(marketId);
  }

  updateStrike(tokenId: string, strike: number): void {
    const market = this.watchedMarkets.get(tokenId);
    if (market) market.strike = strike;
  }

  updateQuote(tokenId: string, bestBid: number, bestAsk: number): void {
    this.priceStates.set(tokenId, { bestBid, bestAsk, lastUpdate: marketNow() });
  }

  getPriceState(tokenId: string): TokenPriceState | undefined {
    return this.priceStates.get(tokenId);
  }

  getStats() {
    return {
      watchedTokens: this.watchedMarkets.size,
      triggersCount: this.triggersCount,
      tradedMarkets: this.tradedMarkets.size,
    };
  }

  /**
   * Score one token against a settlement forecast. Returns the evaluation so the
   * caller can record what the model saw even when nothing is bought, and emits
   * `opportunityDetected` when the trade clears every gate.
   */
  evaluate(tokenId: string, forecast: SettlementForecast): Evaluation | null {
    const market = this.watchedMarkets.get(tokenId);
    if (!market) return null;
    if (this.tradedMarkets.has(market.marketId)) return null;

    const config = getConfig();
    const secondsToEnd = (market.endDate.getTime() - marketNow()) / 1000;

    const quote = this.priceStates.get(tokenId);
    const modelProb =
      market.outcomeLabel === "Up" ? forecast.probUp : 1 - forecast.probUp;
    const bestAsk = quote?.bestAsk ?? 1;
    const edge = modelProb - bestAsk;

    const base = {
      marketId: market.marketId,
      tokenId,
      outcomeLabel: market.outcomeLabel,
      bestAsk,
      modelProb,
      edge,
      forecast,
    };

    if (
      secondsToEnd > config.strategy.entryWindowOpenSeconds ||
      secondsToEnd < config.strategy.entryWindowCloseSeconds
    ) {
      return { ...base, skipReason: "outside_entry_window" };
    }
    if (market.strike === null) return { ...base, skipReason: "no_strike" };
    if (!quote || quote.bestAsk <= 0 || quote.bestAsk >= 1 || quote.bestBid <= 0) {
      return { ...base, skipReason: "quote_missing" };
    }
    if (
      quote.bestAsk < config.strategy.minEntryPrice ||
      quote.bestAsk > config.strategy.maxEntryPrice
    ) {
      return { ...base, skipReason: "price_band" };
    }

    const signedSigmas =
      market.outcomeLabel === "Up" ? forecast.sigmas : -forecast.sigmas;
    if (signedSigmas < config.strategy.minSettlementSigmas) {
      return { ...base, skipReason: "weak_margin" };
    }
    if (edge < config.strategy.minModelEdge) {
      return { ...base, skipReason: "insufficient_edge" };
    }

    this.tradedMarkets.add(market.marketId);
    this.triggersCount++;

    const opportunity: MarketOpportunity = {
      marketId: market.marketId,
      tokenId,
      outcomeLabel: market.outcomeLabel,
      bestAsk: quote.bestAsk,
      bestBid: quote.bestBid,
      strike: market.strike,
      forecast,
      modelProb,
      edge,
      secondsToEnd,
    };

    logger.info(
      {
        marketId: market.marketId,
        outcome: market.outcomeLabel,
        ask: quote.bestAsk.toFixed(3),
        modelProb: modelProb.toFixed(3),
        edge: edge.toFixed(3),
        margin: forecast.margin.toFixed(2),
        sd: forecast.sd.toFixed(2),
        sigmas: forecast.sigmas.toFixed(2),
        secondsToEnd: secondsToEnd.toFixed(1),
      },
      "Opportunity detected (twap roll-off)",
    );

    this.emit("opportunityDetected", opportunity);
    return { ...base, bestAsk: quote.bestAsk, skipReason: null };
  }
}

let instance: StrategyEngine | null = null;
export function getStrategyEngine(): StrategyEngine {
  if (!instance) instance = new StrategyEngine();
  return instance;
}
