import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => childLogger,
  };
  return {
    createModuleLogger: () => childLogger,
    getLogger: () => childLogger,
  };
});

import {
  simulateLimitBuy,
  simulateLimitSell,
  calculateWinProfit,
  stopTriggerPrice,
  calculateFeePerShare,
  type ExecutionResult,
  type SellExecutionResult,
} from "../services/execution-simulator.js";
import { POLYMARKET_MIN_ORDER_SIZE, type ExecutableBook } from "../types/index.js";

function makeOrderbook(
  asks: Array<{ price: string; size: string }>,
  bids: Array<{ price: string; size: string }>,
): ExecutableBook {
  return { bids, asks };
}

describe("simulateLimitBuy", () => {
  it("fills at all ask levels at or below the limit price", () => {
    const orderbook = makeOrderbook(
      [
        { price: "0.93", size: "100" },
        { price: "0.95", size: "200" },
        { price: "0.97", size: "500" },
      ],
      [{ price: "0.92", size: "100" }],
    );

    const result = simulateLimitBuy(orderbook, 1000, 0.95);

    expect(result.fillDetails.length).toBe(2);
    expect(result.fillDetails[0]!.price).toBe(0.93);
    expect(result.fillDetails[1]!.price).toBe(0.95);
    expect(result.fillDetails.every((d) => d.price <= 0.95)).toBe(true);
    expect(result.totalShares).toBeGreaterThan(0);
  });

  it("skips all asks above the limit price", () => {
    const orderbook = makeOrderbook(
      [
        { price: "0.96", size: "100" },
        { price: "0.97", size: "200" },
      ],
      [{ price: "0.94", size: "100" }],
    );

    const result = simulateLimitBuy(orderbook, 1, 0.95);

    expect(result.totalShares).toBe(0);
    expect(result.fillDetails.length).toBe(0);
  });

  it("respects the USD budget", () => {
    const orderbook = makeOrderbook([{ price: "0.50", size: "1000" }], []);

    const result = simulateLimitBuy(orderbook, 1, 0.5);

    expect(result.totalShares).toBeGreaterThan(1.5);
    expect(result.netCost).toBeLessThanOrEqual(1.01);
  });

  it("handles an empty orderbook gracefully", () => {
    const orderbook = makeOrderbook([], []);
    const result = simulateLimitBuy(orderbook, 1, 0.95);

    expect(result.totalShares).toBe(0);
    expect(result.averagePrice).toBe(0);
    expect(result.fees).toBe(0);
  });

  it("fills across multiple ask levels with price improvement", () => {
    const orderbook = makeOrderbook(
      [
        { price: "0.90", size: "5" },
        { price: "0.93", size: "5" },
        { price: "0.95", size: "100" },
      ],
      [],
    );

    const result = simulateLimitBuy(orderbook, 100, 0.97);

    expect(result.fillDetails.length).toBe(3);
    expect(result.averagePrice).toBeGreaterThan(0.9);
    expect(result.averagePrice).toBeLessThan(0.97);
  });

  it("always applies crypto fee — fees > 0 at mid-range price", () => {
    const orderbook = makeOrderbook([{ price: "0.50", size: "100" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.5);

    expect(result.fees).toBeGreaterThan(0);
    expect(result.fees).toBeGreaterThan(0.1);
  });

  it("applies very small fees at extreme prices (near 0.97)", () => {
    const orderbook = makeOrderbook([{ price: "0.97", size: "100" }], []);

    const result = simulateLimitBuy(orderbook, 1, 0.97);

    expect(result.fees).toBeGreaterThanOrEqual(0);
    expect(result.fees).toBeLessThan(0.01);
  });

  it("correctly marks partial fills when budget remains", () => {
    const orderbook = makeOrderbook([{ price: "0.95", size: "0.5" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.isPartialFill).toBe(true);
    expect(result.totalShares).toBeCloseTo(0.5, 1);
  });

  it("belowMinimumOrderSize is true when filled < the protocol minimum", () => {
    const orderbook = makeOrderbook([{ price: "0.95", size: "3" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.totalShares).toBe(3);
    expect(result.belowMinimumOrderSize).toBe(true);
    expect(result.minOrderSize).toBe(POLYMARKET_MIN_ORDER_SIZE);
  });

  it("belowMinimumOrderSize is false when filled >= the protocol minimum", () => {
    const orderbook = makeOrderbook([{ price: "0.95", size: "100" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.totalShares).toBeGreaterThanOrEqual(POLYMARKET_MIN_ORDER_SIZE);
    expect(result.belowMinimumOrderSize).toBe(false);
  });

  it("netCost equals totalCost + fees", () => {
    const orderbook = makeOrderbook([{ price: "0.90", size: "50" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.netCost).toBeCloseTo(result.totalCost + result.fees, 6);
  });
});

describe("simulateLimitSell", () => {
  it("fills at bid levels at or above the limit price", () => {
    const orderbook = makeOrderbook(
      [],
      [
        { price: "0.90", size: "100" },
        { price: "0.85", size: "200" },
        { price: "0.80", size: "500" },
      ],
    );

    const result = simulateLimitSell(orderbook, 50, 0.85);

    expect(result.totalSharesSold).toBe(50);
    expect(result.fillDetails.length).toBe(1);
    expect(result.fillDetails[0]!.price).toBe(0.9);
  });

  it("skips bids below the limit price", () => {
    const orderbook = makeOrderbook(
      [],
      [
        { price: "0.80", size: "100" },
        { price: "0.70", size: "200" },
      ],
    );

    const result = simulateLimitSell(orderbook, 10, 0.85);

    expect(result.totalSharesSold).toBe(0);
    expect(result.fillDetails.length).toBe(0);
  });

  it("panic-sells at any price when limit is 0", () => {
    const orderbook = makeOrderbook(
      [],
      [
        { price: "0.50", size: "10" },
        { price: "0.30", size: "10" },
        { price: "0.10", size: "10" },
      ],
    );

    const result = simulateLimitSell(orderbook, 25, 0);

    expect(result.totalSharesSold).toBe(25);
    expect(result.fillDetails.length).toBe(3);
    expect(result.averagePrice).toBeGreaterThan(0.1);
    expect(result.averagePrice).toBeLessThan(0.5);
  });

  it("handles empty bids gracefully", () => {
    const orderbook = makeOrderbook([], []);
    const result = simulateLimitSell(orderbook, 10, 0);

    expect(result.totalSharesSold).toBe(0);
    expect(result.averagePrice).toBe(0);
    expect(result.netRevenue).toBe(0);
  });

  it("handles partial fills correctly", () => {
    const orderbook = makeOrderbook([], [{ price: "0.80", size: "5" }]);

    const result = simulateLimitSell(orderbook, 100, 0);

    expect(result.totalSharesSold).toBe(5);
    expect(result.isPartialFill).toBe(true);
  });

  it("netRevenue equals grossRevenue minus fees", () => {
    const orderbook = makeOrderbook([], [{ price: "0.80", size: "100" }]);

    const result = simulateLimitSell(orderbook, 20, 0);

    expect(result.netRevenue).toBeCloseTo(result.totalRevenue - result.fees, 6);
  });
});

describe("calculateFeePerShare", () => {
  it("matches Polymarket's published 0.07·p·(1-p) taker fee", () => {
    expect(calculateFeePerShare(0.5)).toBeCloseTo(0.0175, 4);
    expect(calculateFeePerShare(0.7)).toBeCloseTo(0.0147, 4);
    expect(calculateFeePerShare(0.97)).toBeCloseTo(0.002, 4);
  });

  it("is symmetric around 0.50", () => {
    expect(calculateFeePerShare(0.3)).toBeCloseTo(calculateFeePerShare(0.7), 6);
  });

  it("returns peak fee near 0.50", () => {
    const fee50 = calculateFeePerShare(0.5);
    expect(fee50).toBeGreaterThan(0.01);
  });

  it("returns 0 at price 0 and 1", () => {
    expect(calculateFeePerShare(0)).toBe(0);
    expect(calculateFeePerShare(1)).toBe(0);
  });
});

describe("calculateWinProfit", () => {
  it("calculates profit for a winning trade", () => {
    const profit = calculateWinProfit(0.95, 10, 0.01);
    expect(profit).toBeCloseTo(0.49, 4);
  });

  it("returns higher profit for lower entry price", () => {
    const profitAt95 = calculateWinProfit(0.95, 10, 0);
    const profitAt90 = calculateWinProfit(0.9, 10, 0);
    expect(profitAt90).toBeGreaterThan(profitAt95);
  });

  it("returns 0 profit at entry price 1.00", () => {
    const profit = calculateWinProfit(1.0, 10, 0);
    expect(profit).toBeCloseTo(0, 4);
  });
});

describe("stopTriggerPrice", () => {
  it("holds risk per position constant across the entry band", () => {
    for (const entry of [0.15, 0.3, 0.5, 0.75, 0.9]) {
      const trigger = stopTriggerPrice(entry, 0.35);
      expect((entry - trigger) / entry).toBeCloseTo(0.35, 9);
    }
  });

  it("stays reachable at the cheapest allowed entry", () => {
    const trigger = stopTriggerPrice(0.15, 0.35);
    expect(trigger).toBeGreaterThan(0);
    expect(trigger).toBeLessThan(0.15);
  });

  it("widens in absolute cents as entry price rises", () => {
    expect(0.9 - stopTriggerPrice(0.9, 0.35)).toBeGreaterThan(
      0.3 - stopTriggerPrice(0.3, 0.35),
    );
  });
});

describe("stop-loss fill realism", () => {
  const collapsed: ExecutableBook = {
    bids: [
      { price: "0.05", size: "3" },
      { price: "0.02", size: "50" },
    ],
    asks: [],
  };

  it("walks a collapsed book to the bottom for a near-total loss", () => {
    const sell = simulateLimitSell(collapsed, 10, 0);
    expect(sell.totalSharesSold).toBe(10);
    expect(sell.averagePrice).toBeLessThan(0.04);
  });

  it("sells everything it can rather than refusing a bad price", () => {
    const thin: ExecutableBook = { bids: [{ price: "0.01", size: "4" }], asks: [] };
    const sell = simulateLimitSell(thin, 10, 0);
    expect(sell.totalSharesSold).toBe(4);
    expect(sell.isPartialFill).toBe(true);
  });

  it("reports no fill only when the bid side is empty", () => {
    const sell = simulateLimitSell({ bids: [], asks: [] }, 10, 0);
    expect(sell.totalSharesSold).toBe(0);
  });
});
