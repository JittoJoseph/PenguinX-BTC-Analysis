import { createModuleLogger } from "../utils/logger.js";
import {
  CRYPTO_FEE,
  POLYMARKET_MIN_ORDER_SIZE,
  type ExecutableBook,
} from "../types/index.js";
import Decimal from "decimal.js";

const logger = createModuleLogger("execution-simulator");

/** Result of a simulated FAK (Fill-And-Kill) order fill */
export interface ExecutionResult {
  averagePrice: number;
  totalShares: number;
  totalCost: number; // USD spent (before fees)
  fees: number; // Taker fee in USD
  netCost: number; // totalCost + fees
  /** True when budget remains after exhausting all eligible ask levels */
  isPartialFill: boolean;
  belowMinimumOrderSize: boolean;
  minOrderSize: number;
  fillDetails: FillDetail[];
}

interface FillDetail {
  price: number;
  shares: number;
  cost: number;
  feeForLevel: number;
}

/**
 * Simulates a FAK (Fill-And-Kill) taker BUY: walks the ask side up to `limitPrice`,
 * respecting depth at each level, and kills any unfilled budget. Flags
 * `belowMinimumOrderSize` when the fill is under the orderbook's protocol minimum
 * (default 5 shares), which Polymarket would reject.
 */
export function simulateLimitBuy(
  orderbook: ExecutableBook,
  usdAmount: number,
  limitPrice: number,
): ExecutionResult {
  const asks = [...orderbook.asks].sort(
    (a, b) => parseFloat(a.price) - parseFloat(b.price),
  );

  const fillDetails: FillDetail[] = [];
  let remainingUsd = new Decimal(usdAmount);
  let totalShares = new Decimal(0);
  let totalCost = new Decimal(0);
  let totalFees = new Decimal(0);

  for (const level of asks) {
    if (remainingUsd.lte(0)) break;

    const askPrice = parseFloat(level.price);
    const askSize = parseFloat(level.size);

    if (askPrice > limitPrice) break;

    const feePerShare = calculateFeePerShare(askPrice);
    const costPerShare = new Decimal(askPrice).plus(feePerShare);

    const maxSharesByBudget = remainingUsd.div(costPerShare).toNumber();
    const sharesToFill = Math.min(maxSharesByBudget, askSize);

    if (sharesToFill <= 0) continue;

    const shares = new Decimal(sharesToFill);
    const cost = shares.mul(askPrice);
    const fee = shares.mul(feePerShare);

    totalShares = totalShares.plus(shares);
    totalCost = totalCost.plus(cost);
    totalFees = totalFees.plus(fee);
    remainingUsd = remainingUsd.minus(cost).minus(fee);

    fillDetails.push({
      price: askPrice,
      shares: sharesToFill,
      cost: cost.toNumber(),
      feeForLevel: fee.toNumber(),
    });
  }

  const isPartialFill = remainingUsd.gt(0) && totalShares.gt(0);
  const avgPrice = totalShares.gt(0)
    ? totalCost.div(totalShares).toNumber()
    : 0;

  const roundedFees = Math.round(totalFees.toNumber() * 10000) / 10000;

  const minOrderSize = POLYMARKET_MIN_ORDER_SIZE;
  const belowMinimumOrderSize =
    totalShares.gt(0) && totalShares.lt(minOrderSize);

  if (totalShares.gt(0)) {
    logger.debug(
      {
        avgPrice: avgPrice.toFixed(6),
        shares: totalShares.toNumber().toFixed(4),
        cost: totalCost.toNumber().toFixed(4),
        fees: roundedFees.toFixed(4),
        levels: fillDetails.length,
        partial: isPartialFill,
        belowMin: belowMinimumOrderSize,
        minOrderSize,
      },
      "FAK buy simulated",
    );
  }

  return {
    averagePrice: avgPrice,
    totalShares: totalShares.toNumber(),
    totalCost: totalCost.toNumber(),
    fees: roundedFees,
    netCost: totalCost.toNumber() + roundedFees,
    isPartialFill,
    belowMinimumOrderSize,
    minOrderSize,
    fillDetails,
  };
}

/**
 * Polymarket crypto taker fee per share: 0.07 × p × (1-p), rounded to 4dp.
 * Peaks at 50¢, which is where this strategy trades most, so it is a real cost
 * rather than a rounding detail.
 */
export function calculateFeePerShare(price: number): number {
  const fee = CRYPTO_FEE.RATE * price * (1 - price);
  return Math.round(fee * 10000) / 10000;
}

/** Result of a simulated limit SELL */
export interface SellExecutionResult {
  averagePrice: number;
  totalSharesSold: number;
  totalRevenue: number; // USD received (before fees)
  fees: number; // Taker fee in USD
  netRevenue: number; // totalRevenue - fees
  isPartialFill: boolean;
  fillDetails: SellFillDetail[];
  belowMinimumOrderSize: boolean;
}

interface SellFillDetail {
  price: number;
  shares: number;
  revenue: number;
  feeForLevel: number;
}

/**
 * Simulates a limit SELL: walks the bid side from the highest bid down, filling
 * only at bids at or above `limitPrice`. Pass `limitPrice` 0 to accept any bid.
 */
export function simulateLimitSell(
  orderbook: ExecutableBook,
  sharesToSell: number,
  limitPrice: number,
): SellExecutionResult {
  const bids = [...orderbook.bids].sort(
    (a, b) => parseFloat(b.price) - parseFloat(a.price),
  );

  const fillDetails: SellFillDetail[] = [];
  let remainingShares = new Decimal(sharesToSell);
  let totalSharesSold = new Decimal(0);
  let totalRevenue = new Decimal(0);
  let totalFees = new Decimal(0);

  for (const level of bids) {
    if (remainingShares.lte(0)) break;

    const bidPrice = parseFloat(level.price);
    const bidSize = parseFloat(level.size);

    if (bidPrice < limitPrice) break;

    const feePerShare = calculateFeePerShare(bidPrice);
    const sharesToFillAtLevel = Math.min(remainingShares.toNumber(), bidSize);

    if (sharesToFillAtLevel <= 0) continue;

    const shares = new Decimal(sharesToFillAtLevel);
    const revenue = shares.mul(bidPrice);
    const fee = shares.mul(feePerShare);

    totalSharesSold = totalSharesSold.plus(shares);
    totalRevenue = totalRevenue.plus(revenue);
    totalFees = totalFees.plus(fee);
    remainingShares = remainingShares.minus(shares);

    fillDetails.push({
      price: bidPrice,
      shares: sharesToFillAtLevel,
      revenue: revenue.toNumber(),
      feeForLevel: fee.toNumber(),
    });
  }

  const isPartialFill = remainingShares.gt(new Decimal(sharesToSell).mul(0.1));
  const avgPrice = totalSharesSold.gt(0)
    ? totalRevenue.div(totalSharesSold).toNumber()
    : 0;
  const roundedFees = Math.round(totalFees.toNumber() * 10000) / 10000;

  if (totalSharesSold.gt(0)) {
    logger.debug(
      {
        avgPrice: avgPrice.toFixed(6),
        shares: totalSharesSold.toNumber().toFixed(4),
        revenue: totalRevenue.toNumber().toFixed(4),
        fees: roundedFees.toFixed(4),
        levels: fillDetails.length,
        partial: isPartialFill,
      },
      "Limit sell simulated",
    );
  }

  return {
    averagePrice: avgPrice,
    totalSharesSold: totalSharesSold.toNumber(),
    totalRevenue: totalRevenue.toNumber(),
    fees: roundedFees,
    netRevenue: totalRevenue.toNumber() - roundedFees,
    isPartialFill,
    fillDetails,
    belowMinimumOrderSize: false,
  };
}

/**
 * The bid at which a position's stop fires, as a fraction of entry rather than a
 * fixed number of cents. Entries here run from 0.15 to 0.90, and a fixed delta
 * means something different at each end: 25c below entry is 28% of a 0.90
 * position, 83% of a 0.30 one, and unreachable below 0.25, which would leave the
 * cheapest positions with no stop at all. A fraction keeps the risk per position
 * constant across the band.
 */
export function stopTriggerPrice(entryPrice: number, fraction: number): number {
  return entryPrice * (1 - fraction);
}

export function calculateWinProfit(
  entryPrice: number,
  shares: number,
  fees: number,
): number {
  return (1.0 - entryPrice) * shares - fees;
}
