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
  secondsToEnd: number;
}

export type SkipReason =
  | "outside_entry_window"
  | "no_strike"
  | "not_decided"
  | "quote_missing"
  | "price_band";

export interface Evaluation {
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  bestAsk: number | null;
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
 * Buys the winning side of a window that is already decided, whenever the book
 * still offers it cheaply.
 *
 * There is no probability model and no view against the market. The forecast
 * only answers one question — has BTC moved far enough from the strike, with
 * little enough time left, that the outcome is beyond any plausible reversal —
 * and the book answers the other: is anyone still quoting that side as if it
 * were uncertain. The edge lives in resting orders that were placed before the
 * move and never pulled, typically on thin windows where makers have stepped
 * away. Against a book that has repriced there is nothing to do.
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

  /** Drop every trace of the current session, for an admin wipe. */
  reset(): void {
    this.priceStates.clear();
    this.watchedMarkets.clear();
    this.tradedMarkets.clear();
    this.triggersCount = 0;
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
   * Score one token against a settlement forecast. Returns the evaluation so
   * the caller can record what was seen even when nothing is bought, and emits
   * `opportunityDetected` when the token is the decided side and its ask is
   * inside the band.
   */
  evaluate(tokenId: string, forecast: SettlementForecast): Evaluation | null {
    const market = this.watchedMarkets.get(tokenId);
    if (!market) return null;
    if (this.tradedMarkets.has(market.marketId)) return null;

    const config = getConfig();
    const secondsToEnd = (market.endDate.getTime() - marketNow()) / 1000;
    const quote = this.priceStates.get(tokenId);
    const base = {
      marketId: market.marketId,
      tokenId,
      outcomeLabel: market.outcomeLabel,
      bestAsk: quote?.bestAsk ?? null,
      forecast,
    };

    if (
      secondsToEnd > config.strategy.entryWindowOpenSeconds ||
      secondsToEnd < config.strategy.entryWindowCloseSeconds
    ) {
      return { ...base, skipReason: "outside_entry_window" };
    }
    if (market.strike === null) return { ...base, skipReason: "no_strike" };
    if (forecast.decidedSide !== market.outcomeLabel) {
      return { ...base, skipReason: "not_decided" };
    }
    if (!quote || quote.bestAsk <= 0 || quote.bestAsk >= 1 || quote.bestBid <= 0) {
      return { ...base, skipReason: "quote_missing" };
    }
    if (
      quote.bestAsk < config.strategy.minEntryPrice ||
      quote.bestAsk > config.strategy.maxEntryPrice
    ) {
      return { ...base, skipReason: "price_band" };
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
      secondsToEnd,
    };

    logger.info(
      {
        marketId: market.marketId,
        outcome: market.outcomeLabel,
        ask: quote.bestAsk.toFixed(3),
        margin: forecast.margin.toFixed(2),
        floor: forecast.floor.toFixed(2),
        sd: forecast.sd.toFixed(2),
        secondsToEnd: secondsToEnd.toFixed(1),
      },
      "Opportunity detected (decided window, stale ask)",
    );

    this.emit("opportunityDetected", opportunity);
    return { ...base, skipReason: null };
  }
}

let instance: StrategyEngine | null = null;
export function getStrategyEngine(): StrategyEngine {
  if (!instance) instance = new StrategyEngine();
  return instance;
}
