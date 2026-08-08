import { createModuleLogger } from "../utils/logger.js";
import { insertMarketRegimeData, getMarketTradeSummary } from "../db/client.js";
import type { BtcPriceWatcher } from "./btc-price-watcher.js";

const logger = createModuleLogger("market-recorder");

export interface CompletedMarket {
  marketId: string;
  slug: string | null;
  windowType: string;
  windowStart: Date;
  windowEnd: Date;
  /** BTC price at window open — the value the market resolved against. */
  btcStartPrice: number | null;
  winningOutcome: string | null;
}

interface BtcWindowStats {
  endPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  sigmaPerSec: number | null;
  strikeCrossings: number | null;
  tickCount: number;
}

export function summariseBtcWindow(
  ticks: Array<{ price: number; timestamp: number }>,
  strike: number | null,
): BtcWindowStats {
  if (ticks.length === 0) {
    return {
      endPrice: null,
      highPrice: null,
      lowPrice: null,
      sigmaPerSec: null,
      strikeCrossings: null,
      tickCount: 0,
    };
  }

  let high = ticks[0]!.price;
  let low = ticks[0]!.price;
  let sumSq = 0;
  let elapsedSec = 0;

  for (let i = 0; i < ticks.length; i++) {
    const price = ticks[i]!.price;
    if (price > high) high = price;
    if (price < low) low = price;

    if (i > 0) {
      const dp = price - ticks[i - 1]!.price;
      const dt = (ticks[i]!.timestamp - ticks[i - 1]!.timestamp) / 1000;
      if (dt > 0) {
        sumSq += dp * dp;
        elapsedSec += dt;
      }
    }
  }

  // Sign flips of (price - strike): how often the favourite changed hands.
  let crossings: number | null = null;
  if (strike !== null) {
    crossings = 0;
    let lastSide = 0;
    for (const t of ticks) {
      const side = Math.sign(t.price - strike);
      if (side === 0) continue;
      if (lastSide !== 0 && side !== lastSide) crossings++;
      lastSide = side;
    }
  }

  return {
    endPrice: ticks[ticks.length - 1]!.price,
    highPrice: high,
    lowPrice: low,
    sigmaPerSec: elapsedSec > 0 ? Math.sqrt(sumSq / elapsedSec) : null,
    strikeCrossings: crossings,
    tickCount: ticks.length,
  };
}

/**
 * Record one completed market window. Idempotent via a unique index on
 * marketId, so repeated calls for the same market are no-ops. Purely
 * observational — never throws into the caller's path.
 */
export async function recordCompletedMarket(
  market: CompletedMarket,
  btcWatcher: BtcPriceWatcher,
): Promise<void> {
  const stats = summariseBtcWindow(
    btcWatcher.getHistoryBetween(
      market.windowStart.getTime(),
      market.windowEnd.getTime(),
    ),
    market.btcStartPrice,
  );

  const { tradeTaken, outcome } = await getMarketTradeSummary(market.marketId);

  const inserted = await insertMarketRegimeData({
    marketId: market.marketId,
    slug: market.slug,
    windowType: market.windowType,
    windowStart: market.windowStart,
    windowEnd: market.windowEnd,
    btcStartPrice: market.btcStartPrice,
    btcEndPrice: stats.endPrice,
    btcHighPrice: stats.highPrice,
    btcLowPrice: stats.lowPrice,
    btcSigmaPerSec: stats.sigmaPerSec,
    btcStrikeCrossings: stats.strikeCrossings,
    btcTickCount: stats.tickCount,
    winningOutcome: market.winningOutcome,
    tradeTaken,
    outcome,
  });

  if (inserted) {
    logger.debug(
      {
        marketId: market.marketId,
        slug: market.slug,
        winner: market.winningOutcome,
        tradeTaken,
        outcome,
        ticks: stats.tickCount,
      },
      "Market window recorded",
    );
  }
}
