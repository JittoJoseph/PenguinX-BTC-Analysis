import { createModuleLogger } from "../utils/logger.js";
import { getDb, getPortfolio } from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, desc, and, gte } from "drizzle-orm";
import Decimal from "decimal.js";

const logger = createModuleLogger("performance-calculator");

export type TimePeriod = "1D" | "1W" | "1M" | "ALL";

export interface PerformanceMetrics {
  period: TimePeriod;
  totalPnl: string;
  /** Total actual cost spent across all trades in the period */
  totalDeployed: string;
  /** ROI = (portfolioValue - initialCapital) / initialCapital × 100 */
  roi: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  avgWin: string;
  avgLoss: string;
  largestWin: string;
  largestLoss: string;
  totalFees: string;
  avgMarginOverFloor: string;
  openPositions: number;
  unrealizedPnl: string;
  /** Current cash balance from portfolio */
  cashBalance: string;
  /** Initial capital from portfolio */
  initialCapital: string;
  /** Estimated open positions value (needs live prices — computed by caller) */
  openPositionsValue: string;
}

function getPeriodStart(period: TimePeriod): Date | null {
  if (period === "ALL") return null;
  const now = new Date();
  switch (period) {
    case "1D":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "1W":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "1M":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
}

export async function calculatePortfolioPerformance(
  period: TimePeriod,
  livePriceMap?: Map<string, number>,
  openPositionsValue?: number,
): Promise<PerformanceMetrics> {
  const db = getDb();
  const periodStart = getPeriodStart(period);

  const conditions = [];
  if (periodStart) {
    conditions.push(gte(schema.simulatedTrades.entryTs, periodStart));
  }

  const baseQuery = db
    .select()
    .from(schema.simulatedTrades)
    .orderBy(desc(schema.simulatedTrades.entryTs));

  const trades =
    conditions.length > 0
      ? await baseQuery.where(and(...conditions))
      : await baseQuery;

  const portfolio = await getPortfolio();
  const cashBalance = portfolio
    ? new Decimal(portfolio.cashBalance)
    : new Decimal(0);
  const initialCapital = portfolio
    ? new Decimal(portfolio.initialCapital)
    : new Decimal(0);
  const positionsValue = new Decimal(openPositionsValue ?? 0);

  let totalPnl = new Decimal(0);
  let totalDeployed = new Decimal(0);
  let totalFees = new Decimal(0);
  let wins = 0;
  let losses = 0;
  let winPnlSum = new Decimal(0);
  let lossPnlSum = new Decimal(0);
  let largestWin = new Decimal(0);
  let largestLoss = new Decimal(0);
  let marginRatioSum = new Decimal(0);
  let marginRatioCount = 0;
  let openPositions = 0;
  let unrealizedPnl = new Decimal(0);

  for (const trade of trades) {
    const cost = new Decimal(trade.actualCost);
    totalDeployed = totalDeployed.plus(cost);
    totalFees = totalFees.plus(new Decimal(trade.entryFees ?? "0"));

    if (trade.status === "SETTLED" && trade.realizedPnl !== null) {
      const pnl = new Decimal(trade.realizedPnl);
      totalPnl = totalPnl.plus(pnl);

      if (trade.exitOutcome === "WIN") {
        wins++;
        winPnlSum = winPnlSum.plus(pnl);
        if (pnl.gt(largestWin)) largestWin = pnl;
      } else {
        losses++;
        lossPnlSum = lossPnlSum.plus(pnl);
        if (pnl.lt(largestLoss)) largestLoss = pnl;
      }
    } else if (trade.status === "OPEN") {
      openPositions++;
      if (livePriceMap && trade.tokenId) {
        const currentPrice = livePriceMap.get(trade.tokenId);
        if (currentPrice !== undefined) {
          const entryPrice = parseFloat(trade.entryPrice);
          const shares = parseFloat(trade.entryShares);
          const fees = parseFloat(trade.entryFees ?? "0");
          const uPnl = (currentPrice - entryPrice) * shares - fees;
          unrealizedPnl = unrealizedPnl.plus(uPnl);
        }
      }
    }

    if (trade.forecastMarginUsd && trade.decidedFloorUsd) {
      const floor = new Decimal(trade.decidedFloorUsd);
      if (floor.gt(0)) {
        marginRatioSum = marginRatioSum.plus(
          new Decimal(trade.forecastMarginUsd).abs().div(floor),
        );
        marginRatioCount++;
      }
    }
  }

  const closedTrades = wins + losses;
  const totalTrades = trades.length;
  const winRate =
    closedTrades > 0 ? ((wins / closedTrades) * 100).toFixed(2) : "0.00";

  const portfolioValue = cashBalance.plus(positionsValue);
  const roi = initialCapital.gt(0)
    ? portfolioValue
        .minus(initialCapital)
        .div(initialCapital)
        .mul(100)
        .toFixed(2)
    : "0.00";

  const avgWin = wins > 0 ? winPnlSum.div(wins).toFixed(6) : "0";
  const avgLoss = losses > 0 ? lossPnlSum.div(losses).toFixed(6) : "0";
  const avgMarginOverFloor =
    marginRatioCount > 0
      ? marginRatioSum.div(marginRatioCount).toFixed(4)
      : "0";

  return {
    period,
    totalPnl: totalPnl.toFixed(6),
    totalDeployed: totalDeployed.toFixed(2),
    roi,
    totalTrades,
    wins,
    losses,
    winRate,
    avgWin,
    avgLoss,
    largestWin: largestWin.toFixed(6),
    largestLoss: largestLoss.toFixed(6),
    totalFees: totalFees.toFixed(6),
    avgMarginOverFloor,
    openPositions,
    unrealizedPnl: unrealizedPnl.toFixed(6),
    cashBalance: cashBalance.toFixed(2),
    initialCapital: initialCapital.toFixed(2),
    openPositionsValue: positionsValue.toFixed(2),
  };
}
