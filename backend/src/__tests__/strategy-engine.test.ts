import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop,
    child: () => childLogger,
  };
  return { createModuleLogger: () => childLogger, getLogger: () => childLogger };
});

const strategyConfig = {
  entryWindowOpenSeconds: 50,
  entryWindowCloseSeconds: 10,
  minEntryPrice: 0.15,
  maxEntryPrice: 0.9,
  minModelEdge: 0.06,
  minSettlementSigmas: 0.35,
  sigmaWindowMs: 180_000,
  maxRawStalenessMs: 5_000,
  stopLossFraction: 0.35,
  scanIntervalMs: 60_000,
  executionLatencyMs: 250,
};

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({ strategy: strategyConfig }),
}));

const NOW = 1_800_000_000_000;
vi.mock("../services/market-clock.js", () => ({ marketNow: () => NOW }));

const { StrategyEngine } = await import("../services/strategy-engine.js");
const { forecastSettlement, rollingOutRange } = await import(
  "../services/settlement-model.js"
);

const END = NOW + 30_000;

function makeForecast(opts: { rawNow: number; rollingOutMean: number; strike: number }) {
  return forecastSettlement({
    anchorMs: NOW,
    endMs: END,
    strike: opts.strike,
    twapNow: 100_000,
    rawNow: opts.rawNow,
    rollingOutMean: opts.rollingOutMean,
    rawSigma: 4,
  })!;
}

describe("forecastSettlement", () => {
  it("expects no move when spot equals the stretch that is rolling out", () => {
    const f = makeForecast({ rawNow: 100_000, rollingOutMean: 100_000, strike: 100_000 });
    expect(f.expected).toBeCloseTo(100_000, 6);
    expect(f.probUp).toBeCloseTo(0.5, 6);
  });

  it("carries half of the spot-vs-rolling-out gap at tau = W/2", () => {
    const f = makeForecast({ rawNow: 100_060, rollingOutMean: 100_000, strike: 100_000 });
    expect(f.secondsToEnd).toBe(30);
    expect(f.expected).toBeCloseTo(100_030, 6);
    expect(f.margin).toBeCloseTo(30, 6);
  });

  it("drags the settlement below a strike the TWAP is still above", () => {
    const f = makeForecast({ rawNow: 99_900, rollingOutMean: 100_100, strike: 100_020 });
    expect(f.expected).toBeLessThan(100_000);
    expect(f.margin).toBeLessThan(0);
    expect(f.probUp).toBeLessThan(0.5);
  });

  it("matches the closed-form settlement sd inside the lookback", () => {
    const f = makeForecast({ rawNow: 100_000, rollingOutMean: 100_000, strike: 100_000 });
    expect(f.sd).toBeCloseTo((4 * Math.pow(30, 1.5)) / (Math.sqrt(3) * 60), 6);
  });

  it("is far tighter than a random walk over the same horizon", () => {
    const f = makeForecast({ rawNow: 100_000, rollingOutMean: 100_000, strike: 100_000 });
    expect(f.sd).toBeLessThan(4 * Math.sqrt(30) * 0.4);
  });

  it("adds plain diffusion variance beyond the lookback", () => {
    const far = forecastSettlement({
      anchorMs: NOW,
      endMs: NOW + 120_000,
      strike: 100_000,
      twapNow: 100_000,
      rawNow: 100_000,
      rollingOutMean: 100_000,
      rawSigma: 4,
    })!;
    expect(far.sd).toBeCloseTo(4 * Math.sqrt(60 + 60 / 3), 6);
  });

  it("expects plain spot once the whole averaging window is in the future", () => {
    const far = forecastSettlement({
      anchorMs: NOW,
      endMs: NOW + 120_000,
      strike: 100_000,
      twapNow: 100_000,
      rawNow: 100_500,
      rollingOutMean: 99_000,
      rawSigma: 4,
    })!;
    expect(far.expected).toBeCloseTo(100_500, 6);
  });

  it("never reports more than 99% certainty", () => {
    const f = makeForecast({ rawNow: 200_000, rollingOutMean: 100_000, strike: 100_000 });
    expect(f.probUp).toBeLessThanOrEqual(0.99);
  });

  it("returns null once the window has closed", () => {
    expect(
      forecastSettlement({
        anchorMs: END,
        endMs: END,
        strike: 100_000,
        twapNow: 100_000,
        rawNow: 100_000,
        rollingOutMean: 100_000,
        rawSigma: 4,
      }),
    ).toBeNull();
  });
});

describe("rollingOutRange", () => {
  it("covers the tau seconds that leave the average, ending in the past", () => {
    const { fromMs, toMs } = rollingOutRange(NOW, END);
    expect(fromMs).toBe(NOW - 60_000);
    expect(toMs).toBe(NOW - 30_000);
  });

  it("never asks for more than the lookback", () => {
    const { fromMs, toMs } = rollingOutRange(NOW, NOW + 300_000);
    expect(toMs - fromMs).toBe(60_000);
  });
});

describe("StrategyEngine", () => {
  let engine: InstanceType<typeof StrategyEngine>;

  const UP = "token-up";
  const DOWN = "token-down";

  beforeEach(() => {
    engine = new StrategyEngine();
    engine.registerMarket("m1", UP, "Up", new Date(END), 100_000);
    engine.registerMarket("m1", DOWN, "Down", new Date(END), 100_000);
  });

  const strongUp = () =>
    makeForecast({ rawNow: 100_120, rollingOutMean: 100_000, strike: 100_000 });

  it("emits when the model beats the ask by more than the threshold", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.6, 0.62);

    const evaluation = engine.evaluate(UP, strongUp());

    expect(evaluation?.skipReason).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].outcomeLabel).toBe("Up");
    expect(handler.mock.calls[0]![0].edge).toBeGreaterThan(0.06);
  });

  it("skips when the ask already reflects the model", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.7, 0.72);

    const mild = makeForecast({
      rawNow: 100_008.5,
      rollingOutMean: 100_000,
      strike: 100_000,
    });
    expect(mild.probUp).toBeGreaterThan(0.7);
    expect(engine.evaluate(UP, mild)?.skipReason).toBe("insufficient_edge");
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips an ask above the upside cap even with a big edge", () => {
    engine.updateQuote(UP, 0.93, 0.95);
    expect(engine.evaluate(UP, strongUp())?.skipReason).toBe("price_band");
  });

  it("skips an ask below the price floor", () => {
    engine.updateQuote(UP, 0.05, 0.1);
    expect(engine.evaluate(UP, strongUp())?.skipReason).toBe("price_band");
  });

  it("skips the wrong side of a confident forecast", () => {
    engine.updateQuote(DOWN, 0.18, 0.2);
    expect(engine.evaluate(DOWN, strongUp())?.skipReason).toBe("weak_margin");
  });

  it("buys the cheap side when the roll-off points that way", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(DOWN, 0.38, 0.4);

    const down = makeForecast({
      rawNow: 99_800,
      rollingOutMean: 100_100,
      strike: 100_000,
    });
    const evaluation = engine.evaluate(DOWN, down);

    expect(evaluation?.skipReason).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].outcomeLabel).toBe("Down");
  });

  it("skips when no quote has arrived", () => {
    expect(engine.evaluate(UP, strongUp())?.skipReason).toBe("quote_missing");
  });

  it("skips a market with no strike", () => {
    engine.registerMarket("m2", "t2", "Up", new Date(END), null);
    engine.updateQuote("t2", 0.6, 0.62);
    expect(engine.evaluate("t2", strongUp())?.skipReason).toBe("no_strike");
  });

  it("reports outside the entry window without consuming the market", () => {
    engine.registerMarket("m3", "t3", "Up", new Date(NOW + 300_000), 100_000);
    engine.updateQuote("t3", 0.6, 0.62);
    expect(engine.evaluate("t3", strongUp())?.skipReason).toBe("outside_entry_window");
  });

  it("trades a market only once across both sides", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.6, 0.62);

    engine.evaluate(UP, strongUp());
    engine.evaluate(UP, strongUp());
    expect(handler).toHaveBeenCalledOnce();
    expect(engine.evaluate(DOWN, strongUp())).toBeNull();
  });

  it("releaseMarket lets a failed fill be retried", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.6, 0.62);

    engine.evaluate(UP, strongUp());
    engine.releaseMarket("m1");
    engine.evaluate(UP, strongUp());

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns null for an unregistered token", () => {
    expect(engine.evaluate("unknown", strongUp())).toBeNull();
  });

  describe("reset", () => {
    it("forgets registered markets", () => {
      engine.updateQuote(UP, 0.6, 0.62);
      engine.reset();
      expect(engine.evaluate(UP, strongUp())).toBeNull();
    });

    it("unblocks a market that was already traded", () => {
      const handler = vi.fn();
      engine.on("opportunityDetected", handler);
      engine.updateQuote(UP, 0.6, 0.62);
      engine.evaluate(UP, strongUp());
      expect(handler).toHaveBeenCalledOnce();

      engine.reset();
      engine.registerMarket("m1", UP, "Up", new Date(END), 100_000);
      engine.updateQuote(UP, 0.6, 0.62);
      engine.evaluate(UP, strongUp());

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("clears counters and quotes", () => {
      engine.updateQuote(UP, 0.6, 0.62);
      engine.evaluate(UP, strongUp());
      engine.reset();

      const stats = engine.getStats();
      expect(stats.watchedTokens).toBe(0);
      expect(stats.triggersCount).toBe(0);
      expect(stats.tradedMarkets).toBe(0);
      expect(engine.getPriceState(UP)).toBeUndefined();
    });
  });
});
