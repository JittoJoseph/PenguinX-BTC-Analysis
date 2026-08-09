import { createModuleLogger } from "../utils/logger.js";
import {
  insertMarketRegimeData,
  getMarketTradeSummary,
  getUnresolvedMarketWindows,
  setMarketWinningOutcome,
} from "../db/client.js";
import type { BtcPriceWatcher } from "./btc-price-watcher.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";

const logger = createModuleLogger("market-recorder");

const BATCH = 40;
let resolving = false;

export interface CompletedMarket {
  marketId: string;
  slug: string | null;
  windowType: string;
  windowStart: Date;
  windowEnd: Date;
  /** BTC price at window open — the value the market resolved against. */
  btcStartPrice: number | null;
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
    tradeTaken,
    outcome,
  });

  if (inserted) {
    logger.debug(
      {
        marketId: market.marketId,
        slug: market.slug,
        tradeTaken,
        outcome,
        ticks: stats.tickCount,
      },
      "Market window recorded",
    );
  }
}

export async function resolvePendingOutcomes(): Promise<void> {
  if (resolving) return;
  resolving = true;
  try {
    const pending = await getUnresolvedMarketWindows(BATCH);
    const marketIdBySlug = new Map(
      pending.flatMap((p) => (p.slug ? [[p.slug, p.marketId] as const] : [])),
    );
    if (marketIdBySlug.size === 0) return;

    const markets = await getPolymarketClient().getMarkets({
      slug: [...marketIdBySlug.keys()],
      closed: true,
      limit: marketIdBySlug.size,
    });

    // At most two winners exist, so this is at most two UPDATE statements.
    const idsByWinner = new Map<string, string[]>();
    for (const m of markets) {
      const marketId = m.slug ? marketIdBySlug.get(m.slug) : undefined;
      if (!marketId) continue;
      const idx = PolymarketClient.parseOutcomePrices(m).findIndex(
        (p) => p === 1,
      );
      const winner = PolymarketClient.parseOutcomes(m)[idx];
      if (!winner) continue;
      const ids = idsByWinner.get(winner);
      if (ids) ids.push(marketId);
      else idsByWinner.set(winner, [marketId]);
    }

    let updated = 0;
    for (const [winner, ids] of idsByWinner) {
      await setMarketWinningOutcome(ids, winner);
      updated += ids.length;
    }

    if (updated > 0) {
      logger.info(
        { updated, stillPending: marketIdBySlug.size - updated },
        "Resolved market outcomes",
      );
    }
  } finally {
    resolving = false;
  }
}
