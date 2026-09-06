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
  entryWindowOpenSeconds: 300,
  entryWindowCloseSeconds: 5,
  minEntryPrice: 0.15,
  maxEntryPrice: 0.9,
  decidedFloorMultiplier: 1,
  decidedSdMultiple: 7,
  sigmaWindowMs: 180_000,
  maxRawStalenessMs: 5_000,
  stopLossFraction: 0.35,
  scanIntervalMs: 60_000,
  executionLatencyMs: 50,
  marketLivenessMs: 120_000,
};

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({ strategy: strategyConfig }),
}));

const NOW = 1_800_000_000_000;
vi.mock("../services/market-clock.js", () => ({ marketNow: () => NOW }));

const { StrategyEngine } = await import("../services/strategy-engine.js");
const { forecastSettlement, decidedFloor, rollingOutRange } = await import(
  "../services/settlement-model.js"
);

const PRICE = 100_000;
const END = NOW + 30_000;

function makeForecast(opts: {
  rawNow: number;
  rollingOutMean?: number;
  strike?: number;
  endMs?: number;
  rawSigma?: number;
}) {
  return forecastSettlement({
    anchorMs: NOW,
    endMs: opts.endMs ?? END,
    strike: opts.strike ?? PRICE,
    twapNow: PRICE,
    rawNow: opts.rawNow,
    rollingOutMean: opts.rollingOutMean ?? PRICE,
    rawSigma: opts.rawSigma ?? 2,
    floorMultiplier: 1,
    sdMultiple: 7,
  })!;
}

describe("decidedFloor", () => {
  it("scales with price, not dollars", () => {
    const at100k = decidedFloor(45, 100_000, 0, 1, 7);
    const at200k = decidedFloor(45, 200_000, 0, 1, 7);
    expect(at200k).toBeCloseTo(2 * at100k, 9);
  });

  it("tightens as the close approaches", () => {
    const floors = [10, 20, 45, 90, 200].map((t) => decidedFloor(t, PRICE, 0, 1, 7));
    for (let i = 1; i < floors.length; i++) expect(floors[i]!).toBeGreaterThan(floors[i - 1]!);
  });

  it("matches the calibrated basis points at each band", () => {
    expect(decidedFloor(45, PRICE, 0, 1, 7)).toBeCloseTo((PRICE * 6.5) / 10_000, 9);
    expect(decidedFloor(200, PRICE, 0, 1, 7)).toBeCloseTo((PRICE * 32.5) / 10_000, 9);
  });

  it("rises with the model sd but never falls below the basis-point floor", () => {
    const base = decidedFloor(45, PRICE, 0, 1, 7);
    expect(decidedFloor(45, PRICE, 1, 1, 7)).toBe(base);
    expect(decidedFloor(45, PRICE, 50, 1, 7)).toBe(350);
  });

  it("is unreachable beyond the calibrated horizon", () => {
    expect(decidedFloor(300, PRICE, 0, 1, 7)).toBe(Infinity);
    expect(decidedFloor(600, PRICE, 0, 1, 7)).toBe(Infinity);
  });

  it("honours the multiplier on the basis-point floor only", () => {
    expect(decidedFloor(45, PRICE, 0, 2, 7)).toBeCloseTo(2 * decidedFloor(45, PRICE, 0, 1, 7), 9);
  });
});

describe("forecastSettlement", () => {
  it("expects no move when spot equals the stretch that is rolling out", () => {
    const f = makeForecast({ rawNow: PRICE });
    expect(f.expected).toBeCloseTo(PRICE, 6);
    expect(f.margin).toBeCloseTo(0, 6);
    expect(f.decidedSide).toBeNull();
  });

  it("carries half of the spot-vs-rolling-out gap at tau = W/2", () => {
    const f = makeForecast({ rawNow: PRICE + 60 });
    expect(f.secondsToEnd).toBe(30);
    expect(f.expected).toBeCloseTo(PRICE + 30, 6);
  });

  it("drags the settlement below a strike the TWAP is still above", () => {
    const f = makeForecast({ rawNow: PRICE - 100, rollingOutMean: PRICE + 100, strike: PRICE + 20 });
    expect(f.margin).toBeLessThan(0);
  });

  it("matches the closed-form settlement sd inside the lookback", () => {
    const f = makeForecast({ rawNow: PRICE, rawSigma: 4 });
    expect(f.sd).toBeCloseTo((4 * Math.pow(30, 1.5)) / (Math.sqrt(3) * 60), 6);
  });

  it("expects plain spot once the whole averaging window is in the future", () => {
    const f = makeForecast({ rawNow: PRICE + 500, rollingOutMean: PRICE - 1000, endMs: NOW + 120_000 });
    expect(f.expected).toBeCloseTo(PRICE + 500, 6);
  });

  it("declares a side only when the margin clears the floor", () => {
    const small = makeForecast({ rawNow: PRICE + 30 });
    expect(Math.abs(small.margin)).toBeLessThan(small.floor);
    expect(small.decidedSide).toBeNull();

    const big = makeForecast({ rawNow: PRICE + 600 });
    expect(Math.abs(big.margin)).toBeGreaterThan(big.floor);
    expect(big.decidedSide).toBe("Up");

    const down = makeForecast({ rawNow: PRICE - 600 });
    expect(down.decidedSide).toBe("Down");
  });

  it("never decides beyond the calibrated horizon", () => {
    const far = makeForecast({ rawNow: PRICE + 5000, endMs: NOW + 400_000 });
    expect(far.floor).toBe(Infinity);
    expect(far.decidedSide).toBeNull();
  });

  it("returns null once the window has closed", () => {
    expect(
      forecastSettlement({
        anchorMs: END, endMs: END, strike: PRICE, twapNow: PRICE, rawNow: PRICE,
        rollingOutMean: PRICE, rawSigma: 2, floorMultiplier: 1, sdMultiple: 7,
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
    engine.registerMarket("m1", UP, "Up", new Date(END), PRICE);
    engine.registerMarket("m1", DOWN, "Down", new Date(END), PRICE);
    engine.noteTrade(UP, NOW - 10_000);
  });

  const decidedUp = () => makeForecast({ rawNow: PRICE + 600 });
  const decidedDown = () => makeForecast({ rawNow: PRICE - 600 });
  const undecided = () => makeForecast({ rawNow: PRICE + 30 });

  it("buys the decided side when the book still offers it cheaply", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.5, 0.52);

    const evaluation = engine.evaluate(UP, decidedUp());

    expect(evaluation?.skipReason).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].outcomeLabel).toBe("Up");
    expect(handler.mock.calls[0]![0].bestAsk).toBe(0.52);
  });

  it("does nothing when the window is not decided, however cheap the ask", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.3, 0.32);
    expect(engine.evaluate(UP, undecided())?.skipReason).toBe("not_decided");
    expect(handler).not.toHaveBeenCalled();
  });

  it("never buys the losing side of a decided window", () => {
    engine.updateQuote(DOWN, 0.18, 0.2);
    expect(engine.evaluate(DOWN, decidedUp())?.skipReason).toBe("not_decided");
  });

  it("buys Down when the forecast decides Down", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(DOWN, 0.6, 0.62);
    expect(engine.evaluate(DOWN, decidedDown())?.skipReason).toBeNull();
    expect(handler.mock.calls[0]![0].outcomeLabel).toBe("Down");
  });

  it("skips an ask above the cap even on a decided window", () => {
    engine.updateQuote(UP, 0.94, 0.95);
    expect(engine.evaluate(UP, decidedUp())?.skipReason).toBe("price_band");
  });

  it("skips an ask below the floor", () => {
    engine.updateQuote(UP, 0.05, 0.1);
    expect(engine.evaluate(UP, decidedUp())?.skipReason).toBe("price_band");
  });

  it("skips when no quote has arrived", () => {
    expect(engine.evaluate(UP, decidedUp())?.skipReason).toBe("quote_missing");
  });

  it("skips a market with no strike", () => {
    engine.registerMarket("m2", "t2", "Up", new Date(END), null);
    engine.updateQuote("t2", 0.5, 0.52);
    expect(engine.evaluate("t2", decidedUp())?.skipReason).toBe("no_strike");
  });

  it("skips a market that has not printed a fill recently", () => {
    engine.registerMarket("m4", "t4", "Up", new Date(END), PRICE);
    engine.updateQuote("t4", 0.5, 0.52);
    expect(engine.evaluate("t4", decidedUp())?.skipReason).toBe("market_stale");
    engine.noteTrade("t4", NOW - 200_000);
    expect(engine.evaluate("t4", decidedUp())?.skipReason).toBe("market_stale");
    engine.noteTrade("t4", NOW - 30_000);
    expect(engine.evaluate("t4", decidedUp())?.skipReason).toBeNull();
  });

  it("counts a fill on either side of the market as liveness", () => {
    engine.registerMarket("m5", "t5u", "Up", new Date(END), PRICE);
    engine.registerMarket("m5", "t5d", "Down", new Date(END), PRICE);
    engine.updateQuote("t5u", 0.5, 0.52);
    engine.noteTrade("t5d", NOW - 5_000);
    expect(engine.evaluate("t5u", decidedUp())?.skipReason).toBeNull();
  });

  it("reports outside the entry window without consuming the market", () => {
    engine.registerMarket("m3", "t3", "Up", new Date(NOW + 600_000), PRICE);
    engine.updateQuote("t3", 0.5, 0.52);
    expect(engine.evaluate("t3", decidedUp())?.skipReason).toBe("outside_entry_window");
  });

  it("trades a market only once", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.5, 0.52);
    engine.evaluate(UP, decidedUp());
    engine.evaluate(UP, decidedUp());
    expect(handler).toHaveBeenCalledOnce();
    expect(engine.evaluate(DOWN, decidedUp())).toBeNull();
  });

  it("releaseMarket lets a failed fill be retried", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.updateQuote(UP, 0.5, 0.52);
    engine.evaluate(UP, decidedUp());
    engine.releaseMarket("m1");
    engine.evaluate(UP, decidedUp());
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns null for an unregistered token", () => {
    expect(engine.evaluate("unknown", decidedUp())).toBeNull();
  });

  describe("reset", () => {
    it("forgets registered markets and unblocks traded ones", () => {
      const handler = vi.fn();
      engine.on("opportunityDetected", handler);
      engine.updateQuote(UP, 0.5, 0.52);
      engine.evaluate(UP, decidedUp());
      engine.reset();
      expect(engine.evaluate(UP, decidedUp())).toBeNull();

      engine.registerMarket("m1", UP, "Up", new Date(END), PRICE);
      engine.updateQuote(UP, 0.5, 0.52);
      engine.noteTrade(UP, NOW - 10_000);
      engine.evaluate(UP, decidedUp());
      expect(handler).toHaveBeenCalledTimes(2);
      expect(engine.getStats().tradedMarkets).toBe(1);
    });
  });
});
