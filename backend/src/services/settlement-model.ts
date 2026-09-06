import { WINDOW_CONFIG } from "../types/index.js";

const W = WINDOW_CONFIG.twapLookbackSeconds;

/**
 * Margin, in basis points of price, at which a window is treated as decided,
 * by seconds to close. Calibrated on 383 real 15-minute windows of 1-second
 * BTC data: the smallest margin at which the forecast side won 100% of the
 * time in every band, on every day, in every volatility quartile. Expressed
 * in basis points rather than dollars so it carries across price levels.
 *
 * Beyond 300 seconds no margin reached 99% accuracy, so nothing qualifies.
 */
const DECIDED_FLOOR_BPS: ReadonlyArray<readonly [maxTau: number, bps: number]> = [
  [15, 1.3],
  [30, 2.6],
  [60, 6.5],
  [120, 19.5],
  [300, 32.5],
];

export interface SettlementForecast {
  /** Anchor observation time of the TWAP tick the forecast is built on. */
  anchorMs: number;
  secondsToEnd: number;
  twapNow: number;
  rawNow: number;
  /** Mean of the raw feed over the stretch that is about to leave the average. */
  rollingOutMean: number;
  /** Expected settlement TWAP: what the market resolves against. */
  expected: number;
  /** Standard deviation of that expectation, in dollars. */
  sd: number;
  /** Expected settlement minus the strike, in dollars. */
  margin: number;
  /** Margin the window must clear to count as decided, in dollars. */
  floor: number;
  /** The side that wins if the forecast holds; null when not decided. */
  decidedSide: "Up" | "Down" | null;
}

export interface ForecastInputs {
  anchorMs: number;
  endMs: number;
  strike: number;
  twapNow: number;
  rawNow: number;
  rollingOutMean: number;
  rawSigma: number;
  /** Multiplier on the basis-point floor table. 1 = as calibrated. */
  floorMultiplier: number;
  /** Multiple of the model sd the margin must also clear. */
  sdMultiple: number;
}

/**
 * The 60-second settlement TWAP is a moving average, so at any point inside the
 * final minute part of it is already fixed by prices that have happened. Over
 * the next tau seconds the average sheds its oldest tau seconds and takes on tau
 * seconds of new price, so its expected move is determined by where spot is now
 * relative to the stretch that is leaving:
 *
 *   E[TWAP_end] = TWAP_now + (tau / W) * (spot_now - mean of the leaving stretch)
 *
 * Only the incoming stretch is random, and because it enters as an average its
 * variance grows as tau^3 rather than tau.
 *
 * The forecast is not turned into a probability. Real BTC tails are hundreds of
 * times fatter than a Gaussian at these horizons, and a trailing sigma in a
 * quiet regime makes small margins look certain. Instead a window is decided
 * when the margin clears an empirical floor that scales up with volatility and
 * never down.
 */
export function forecastSettlement(input: ForecastInputs): SettlementForecast | null {
  const tau = (input.endMs - input.anchorMs) / 1000;
  if (tau <= 0) return null;

  // Past tau = W the whole averaging window is still in the future, so the
  // expected settlement is just spot. Inside it the anchored form is exact:
  // any constant offset between our raw integral and Chainlink's own cancels
  // between the two terms, which is what lets us skip reproducing the TWAP.
  const expected =
    tau >= W
      ? input.rawNow
      : input.twapNow + (tau / W) * (input.rawNow - input.rollingOutMean);

  const a = Math.max(0, tau - W);
  const b = tau;
  const varFactor = ((b * b * b - a * a * a) / 3 - a * a * (b - a)) / (W * W);
  if (varFactor <= 0) return null;

  const sd = input.rawSigma * Math.sqrt(varFactor);
  if (!(sd > 0)) return null;

  const margin = expected - input.strike;
  const floor = decidedFloor(tau, input.rawNow, sd, input.floorMultiplier, input.sdMultiple);
  const decidedSide =
    Number.isFinite(floor) && Math.abs(margin) >= floor
      ? margin > 0
        ? "Up"
        : "Down"
      : null;

  return {
    anchorMs: input.anchorMs,
    secondsToEnd: tau,
    twapNow: input.twapNow,
    rawNow: input.rawNow,
    rollingOutMean: input.rollingOutMean,
    expected,
    sd,
    margin,
    floor,
    decidedSide,
  };
}

/**
 * The larger of the calibrated basis-point floor and a multiple of the model
 * sd. The floor is what generalises across price levels; the sd term raises it
 * when the market is volatile. Nothing lowers it: a quiet trailing sigma must
 * never make a small margin look decided.
 */
export function decidedFloor(
  tau: number,
  price: number,
  sd: number,
  floorMultiplier: number,
  sdMultiple: number,
): number {
  const band = DECIDED_FLOOR_BPS.find(([maxTau]) => tau < maxTau);
  if (!band) return Infinity;
  const bpsFloor = (price * band[1] * floorMultiplier) / 10_000;
  return Math.max(bpsFloor, sdMultiple * sd);
}

/** The window that is about to roll out of the average, in wall-clock ms. */
export function rollingOutRange(anchorMs: number, endMs: number): { fromMs: number; toMs: number } {
  const tau = Math.min((endMs - anchorMs) / 1000, W);
  const fromMs = anchorMs - W * 1000;
  return { fromMs, toMs: fromMs + tau * 1000 };
}
