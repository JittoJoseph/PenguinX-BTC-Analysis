import { describe, it, expect, beforeEach, vi } from "vitest";
import { BtcPriceWatcher } from "../services/btc-price-watcher.js";

vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop,
    child: () => childLogger,
  };
  return { createModuleLogger: () => childLogger, getLogger: () => childLogger };
});

type Tick = { price: number; timestamp: number };

function seedRaw(watcher: BtcPriceWatcher, entries: Tick[]): void {
  // @ts-ignore — access private for testing
  watcher["rawHistory"] = entries;
}

function seedTwap(watcher: BtcPriceWatcher, entries: Tick[]): void {
  // @ts-ignore — access private for testing
  watcher["twapHistory"] = entries;
}

function ramp(n: number, start: number, step: number, endMs: number): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ price: start + i * step, timestamp: endMs - (n - 1 - i) * 1000 });
  }
  return out;
}

describe("BtcPriceWatcher.getRawSigma()", () => {
  let watcher: BtcPriceWatcher;
  const NOW = Date.now();

  beforeEach(() => {
    watcher = new BtcPriceWatcher();
  });

  it("returns null when raw history is empty", () => {
    expect(watcher.getRawSigma(60_000)).toBeNull();
  });

  it("returns null with fewer than 30 usable increments", () => {
    seedRaw(watcher, ramp(20, 100_000, 5, NOW));
    expect(watcher.getRawSigma(600_000)).toBeNull();
  });

  it("computes per-second sigma from a constant-step ramp", () => {
    seedRaw(watcher, ramp(61, 100_000, 5, NOW));
    expect(watcher.getRawSigma(600_000)).toBeCloseTo(5, 6);
  });

  it("scales with the size of the moves", () => {
    seedRaw(watcher, ramp(61, 100_000, 20, NOW));
    expect(watcher.getRawSigma(600_000)).toBeCloseTo(20, 6);
  });

  it("is zero for a flat series", () => {
    seedRaw(watcher, ramp(61, 100_000, 0, NOW));
    expect(watcher.getRawSigma(600_000)).toBe(0);
  });

  it("ignores increments spanning a feed gap", () => {
    const ticks = ramp(61, 100_000, 5, NOW);
    ticks.splice(30, 0, { price: 500_000, timestamp: ticks[29]!.timestamp + 30_000 });
    seedRaw(watcher, ticks);
    const sigma = watcher.getRawSigma(600_000);
    expect(sigma).not.toBeNull();
    expect(sigma!).toBeLessThan(100);
  });
});

describe("BtcPriceWatcher.getRawMean()", () => {
  let watcher: BtcPriceWatcher;
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    watcher = new BtcPriceWatcher();
  });

  it("returns null when the range is not covered", () => {
    seedRaw(watcher, ramp(10, 100_000, 1, NOW));
    expect(watcher.getRawMean(NOW - 60_000, NOW - 50_000)).toBeNull();
  });

  it("averages a flat series to its own level", () => {
    seedRaw(watcher, ramp(61, 100_000, 0, NOW));
    expect(watcher.getRawMean(NOW - 30_000, NOW)).toBeCloseTo(100_000, 6);
  });

  it("averages a linear ramp to its midpoint", () => {
    seedRaw(watcher, ramp(61, 100_000, 10, NOW));
    // Over the final 30s the ramp runs from 100_300 to 100_600.
    expect(watcher.getRawMean(NOW - 30_000, NOW)).toBeCloseTo(100_450, 3);
  });

  it("returns null when a gap makes the integral untrustworthy", () => {
    const ticks = ramp(61, 100_000, 10, NOW);
    ticks.splice(40, 8);
    seedRaw(watcher, ticks);
    expect(watcher.getRawMean(NOW - 30_000, NOW)).toBeNull();
  });

  it("rejects an inverted or empty range", () => {
    seedRaw(watcher, ramp(61, 100_000, 10, NOW));
    expect(watcher.getRawMean(NOW, NOW - 1000)).toBeNull();
    expect(watcher.getRawMean(NOW, NOW)).toBeNull();
  });
});

describe("BtcPriceWatcher.getTwapAt()", () => {
  let watcher: BtcPriceWatcher;
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    watcher = new BtcPriceWatcher();
  });

  it("returns null with no history", () => {
    expect(watcher.getTwapAt(NOW)).toBeNull();
  });

  it("returns the last observation at or before the target", () => {
    seedTwap(watcher, ramp(61, 100_000, 10, NOW));
    expect(watcher.getTwapAt(NOW)).toBeCloseTo(100_600, 6);
    expect(watcher.getTwapAt(NOW - 10_000)).toBeCloseTo(100_500, 6);
  });

  it("returns null for a target before the first observation", () => {
    seedTwap(watcher, ramp(61, 100_000, 10, NOW));
    expect(watcher.getTwapAt(NOW - 120_000)).toBeNull();
  });
});
