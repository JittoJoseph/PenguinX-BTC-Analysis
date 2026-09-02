import { WINDOW_CONFIG } from "../types/index.js";

const W = WINDOW_CONFIG.twapLookbackSeconds;

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
  /** Margin expressed in settlement standard deviations. */
  sigmas: number;
  probUp: number;
}

export interface ForecastInputs {
  anchorMs: number;
  endMs: number;
  strike: number;
  twapNow: number;
  rawNow: number;
  rollingOutMean: number;
  rawSigma: number;
}

/**
 * The 60-second settlement TWAP is a moving average, so at any point inside the
 * final minute part of it is already fixed by prices that have happened. Over
 * the next tau seconds the average sheds the oldest tau seconds and takes on tau
 * seconds of new price, so its expected move is entirely determined by where
 * spot is now relative to the stretch that is leaving:
 *
 *   E[TWAP_end] = TWAP_now + (tau / W) * (spot_now - mean of the leaving stretch)
 *
 * Only the incoming stretch is random, and because it enters as an average its
 * variance grows as tau^3 rather than tau. Both effects are large and neither is
 * visible to anyone reading the TWAP level alone.
 */
export function forecastSettlement(input: ForecastInputs): SettlementForecast | null {
  const tau = (input.endMs - input.anchorMs) / 1000;
  if (tau <= 0) return null;

  // Past tau = W the whole averaging window is still in the future, so the
  // expected settlement is just spot. Inside it, the anchored form is exact:
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
  const sigmas = margin / sd;

  return {
    anchorMs: input.anchorMs,
    secondsToEnd: tau,
    twapNow: input.twapNow,
    rawNow: input.rawNow,
    rollingOutMean: input.rollingOutMean,
    expected,
    sd,
    margin,
    sigmas,
    probUp: clampProbability(normalCdf(sigmas)),
  };
}

/** The window that is about to roll out of the average, in wall-clock ms. */
export function rollingOutRange(anchorMs: number, endMs: number): { fromMs: number; toMs: number } {
  const tau = Math.min((endMs - anchorMs) / 1000, W);
  const fromMs = anchorMs - W * 1000;
  return { fromMs, toMs: fromMs + tau * 1000 };
}

/**
 * A Gaussian understates BTC jump risk, so no side is ever treated as more
 * certain than 99%. Without this the model would happily pay 0.99 for a
 * contract whose true tail is several times larger.
 */
function clampProbability(p: number): number {
  return Math.max(0.01, Math.min(0.99, p));
}

/** Abramowitz & Stegun 26.2.17. */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
