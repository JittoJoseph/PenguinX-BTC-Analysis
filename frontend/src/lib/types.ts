export interface SimulatedTrade {
  id: string;
  marketId: string | null;
  tokenId: string | null;
  marketCategory: string | null;
  windowType: string | null;
  side: string;
  outcomeLabel: string | null;
  orderType: string;
  entryTs: string;
  entryPrice: string;
  entryShares: string;
  positionBudget: string;
  actualCost: string;
  entryFees: string | null;
  fillStatus: string | null;
  /** Settlement TWAP at entry */
  twapAtEntry: string | null;
  /** Unsmoothed Chainlink price at entry */
  rawAtEntry: string | null;
  /** The window-open TWAP the market resolves against */
  strike: string | null;
  /** Forecast settlement TWAP at window end */
  forecastSettlement: string | null;
  /** Forecast settlement minus strike, in dollars */
  forecastMarginUsd: string | null;
  /** Standard deviation of the settlement forecast, in dollars */
  forecastSdUsd: string | null;
  /** Margin the window had to clear to count as decided, in dollars */
  decidedFloorUsd: string | null;
  secondsToEnd: string | null;
  /** Lowest executable best bid observed while the position was open */
  minPriceDuringPosition: string | null;
  exitPrice: string | null;
  exitTs: string | null;
  exitOutcome: string | null;
  /** RESOLUTION | STOP_LOSS */
  exitReason: string | null;
  realizedPnl: string | null;
  status: string;
  orderbookSnapshot: unknown;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
  /** Joined from markets table */
  marketEndDate: string | null;
  /** Joined from markets table */
  marketSlug: string | null;
  /** Joined from markets table */
  marketQuestion: string | null;
}

export interface LiveMarketPrice {
  bid: number;
  ask: number;
}

export interface LiveMarketInfo {
  marketId: string;
  question: string;
  slug: string | null;
  endDate: string;
  /** endDate - windowDuration */
  windowStart: string;
  yesTokenId: string;
  noTokenId: string;
  prices: Record<string, LiveMarketPrice>;
  /** ACTIVE = window open; UPCOMING = not yet started; ENDED = awaiting resolution */
  status: "ACTIVE" | "ENDED" | "UPCOMING";
  hasPosition: boolean;
  btcPriceAtWindowStart: number | null;
}

/** Live observables for a currently-open position, mirrored from the backend. */
export interface OpenPositionSnapshot {
  tradeId: string;
  tokenId: string;
  marketId: string;
  /** Lowest executable best bid seen since entry. */
  minPriceDuringPosition: number;
  stopLossPrice: number;
  /** Shares still held; a partly filled stop leaves a remainder. */
  remainingShares: number;
}

/**
 * The single live-state model. The REST snapshot and every WebSocket update
 * carry this exact shape, so there is no separate "initial" state to merge.
 */
export interface LiveState {
  orchestrator: {
    running: boolean;
    paused: boolean;
    activeMarkets: number;
    openPositions: number;
    cycleCount: number;
    scanner: { discoveredCount: number };
    ws: {
      connected: boolean;
      subscribedTokens: number;
      maintainedBooks: number;
      messageCount: number;
      reconnectAttempts: number;
    };
    strategy: {
      watchedTokens: number;
      triggersCount: number;
      tradedMarkets: number;
    };
    btcConnected: boolean;
    btcPrice: number | null;
    /** BTC realized per-second volatility in USD (null until enough data) */
    rawSigma: number | null;
    btcRawPrice: number | null;
  };
  liveMarkets: LiveMarketInfo[];
  openPositions: OpenPositionSnapshot[];
  btcPrice: { price: number; timestamp: number } | null;
  portfolio: {
    cashBalance: number;
    initialCapital: number;
    openPositionsValue: number;
  };
  config: {
    marketWindow: string;
    twapLookbackSeconds: number;
    maxEntryPrice: number;
    entryWindowOpenSeconds: number;
    entryWindowCloseSeconds: number;
    sigmaWindowMs: number;
    decidedFloorMultiplier: number;
    decidedSdMultiple: number;
    marketLivenessMs: number;
    stopLossFraction: number;
    startingCapital: number;
    positionBudgetUsd: number;

    minEntryPrice: number;
  };
  /** Backend's sync to Polymarket's clock; surfaced so drift is observable. */
  clock: {
    offsetMs: number;
    syncedAtMs: number | null;
    lastRttMs: number | null;
    synced: boolean;
  };
  /** Market time (epoch ms) at send. Clients count down from this, not their own clock. */
  timestamp: number;
}

export type ActivityKind =
  | "TRADE_OPENED"
  | "TRADE_WIN"
  | "TRADE_LOSS"
  | "MARKET_RESOLVED"
  | "SYSTEM"
  | "INFO"
  | "WARN"
  | "ERROR";

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  ts: number;
  trade?: SimulatedTrade;
  pnl?: number;
}

export interface DiscoveredMarket {
  id: string;
  conditionId: string | null;
  slug: string | null;
  question: string | null;
  windowType: string;
  category: string;
  endDate: string | null;
  targetPrice: string | null;
  active: boolean;
  outcomes: unknown;
  clobTokenIds: unknown;
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  computedStatus?: "ACTIVE" | "ENDED";
}

export interface PerformanceMetrics {
  period: string;
  totalPnl: string;
  totalDeployed: string;
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
  cashBalance: string;
  initialCapital: string;
  openPositionsValue: string;
}

export interface PortfolioState {
  initialCapital: number;
  cashBalance: number;
  openPositionsValue: number;
  portfolioValue: number;
  roi: number;
  createdAt: string;
  updatedAt: string;
}

export interface MonteCarloHistogram {
  min: number;
  max: number;
  count: number;
}

export interface EquityCurvePoint {
  tradeIndex: number;
  balance: number;
}

export interface PercentileEquityCurve {
  percentile: number;
  curve: EquityCurvePoint[];
}

export interface MonteCarloResult {
  config: { simulations: number; tradesPerSim: number };
  historical: {
    totalSettled: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWinPnl: number;
    avgLossPnl: number;
    avgWinPct: number;
    avgLossPct: number;
    largestWin: number;
    largestLoss: number;
    profitFactor: number;
    expectancy: number;
  };
  distribution: {
    histogram: MonteCarloHistogram[];
    percentiles: {
      p5: number;
      p25: number;
      p50: number;
      p75: number;
      p95: number;
    };
    mean: number;
    stdDev: number;
    profitProbability: number;
    ruinProbability: number;
  };
  equityCurves: PercentileEquityCurve[];
  drawdown: { median: number; p95: number; worst: number };
  startingCapital: number;
}

export interface AuditLog {
  id: string;
  level: string;
  category: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface HealthResponse {
  status: string;
  uptime: number;
  [key: string]: unknown;
}

export interface WsMessage {
  type: "liveState" | "tradeOpened" | "tradeResolved" | "pong";
  data?: unknown;
}

/** The one supported market. Everything else was removed with the 5m strategy. */
export const MARKET_WINDOW_LABEL = "BTC 15-MIN";
export const MARKET_WINDOW_DURATION_MS = 15 * 60 * 1000;
