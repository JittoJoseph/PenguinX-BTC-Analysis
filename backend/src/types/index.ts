import { z } from "zod";

export const MARKET_WINDOW = "15M" as const;
export type MarketWindow = typeof MARKET_WINDOW;

export interface WindowConfig {
  slugPrefix: string;
  durationMs: number;
  category: string;
  label: string;
  cryptoMarketConfigId: string;
  twapLookbackSeconds: number;
  rtdsTwapTopic: string;
}

export const WINDOW_CONFIG: WindowConfig = {
  slugPrefix: "btc-updown-15m",
  durationMs: 15 * 60 * 1000,
  category: "btc-15m",
  label: "BTC 15-Minute",
  cryptoMarketConfigId: "btc-15m-twap-60",
  twapLookbackSeconds: 60,
  rtdsTwapTopic: "crypto_prices_twap_sixty",
};

export const RTDS_RAW_TOPIC = "crypto_prices_chainlink";

export const POLY_URLS = {
  GAMMA_API_BASE: "https://gamma-api.polymarket.com",
  CLOB_BASE: "https://clob.polymarket.com",
  CLOB_WS: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  RTDS_WS: "wss://ws-live-data.polymarket.com",
} as const;

// https://docs.polymarket.com/trading/fees — taker fee per share = 0.07·p·(1-p).
// Makers pay nothing; we are takers on both entry and exit.
export const CRYPTO_FEE = {
  RATE: 0.07,
} as const;

// Protocol minimum order size in shares (CLOB orderbook `min_order_size`)
export const POLYMARKET_MIN_ORDER_SIZE = 5;
export const FIXED_POSITION_BUDGET_USD = 5;

export const ConfigSchema = z.object({
  db: z.object({
    url: z.string(),
  }),
  portfolio: z.object({
    startingCapital: z.number().min(1).max(10_000_000),
  }),
  strategy: z.object({
    entryWindowOpenSeconds: z.number().min(5).max(900),
    entryWindowCloseSeconds: z.number().min(1).max(120),
    minEntryPrice: z.number().min(0.01).max(0.9),
    maxEntryPrice: z.number().min(0.1).max(0.99),
    /** Multiplier on the calibrated basis-point decided floor. 1 = as calibrated. */
    decidedFloorMultiplier: z.number().min(0.5).max(5),
    /** Multiple of the model sd the margin must also clear; raises the floor in volatile regimes. */
    decidedSdMultiple: z.number().min(0).max(30),
    sigmaWindowMs: z.number().min(10_000).max(600_000),
    maxRawStalenessMs: z.number().min(1000).max(60_000),
    /** Stop trigger as a fraction of entry price. Always active. */
    stopLossFraction: z.number().min(0.05).max(0.9),
    scanIntervalMs: z.number().min(10000),
    /** Simulated submit→match round-trip; the book keeps moving in between. */
    executionLatencyMs: z.number().min(0).max(5000),
  }),
  admin: z.object({
    password: z.string().min(1),
  }),
  server: z.object({
    port: z.number().min(1).max(65535),
    host: z.string(),
  }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  }),
  env: z.enum(["development", "production", "test"]),
});

export type Config = z.infer<typeof ConfigSchema>;

export const GammaTagSchema = z.object({
  id: z.number().or(z.string()),
  label: z.string().optional(),
  slug: z.string().optional(),
});
export type GammaTag = z.infer<typeof GammaTagSchema>;

export const GammaMarketSchema = z.object({
  id: z.string(),
  question: z.string().nullable().optional(),
  conditionId: z.string().optional(),
  slug: z.string().nullable().optional(),
  clobTokenIds: z.string().nullable().optional(),
  outcomes: z.string().nullable().optional(),
  outcomePrices: z.string().nullable().optional(),
  volume: z.string().nullable().optional(),
  volumeNum: z.number().nullable().optional(),
  liquidity: z.string().nullable().optional(),
  liquidityNum: z.number().nullable().optional(),
  active: z.boolean().nullable().optional(),
  closed: z.boolean().nullable().optional(),
  enableOrderBook: z.boolean().nullable().optional(),
  acceptingOrders: z.boolean().nullable().optional(),
  makerBaseFee: z.number().nullable().optional(),
  takerBaseFee: z.number().nullable().optional(),
  fee: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  bestBid: z.number().nullable().optional(),
  bestAsk: z.number().nullable().optional(),
  lastTradePrice: z.number().nullable().optional(),
  spread: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  resolutionSource: z.string().nullable().optional(),
  tags: z.array(GammaTagSchema).optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type GammaMarket = z.infer<typeof GammaMarketSchema>;

export const GammaEventSchema = z.object({
  id: z.string().or(z.number()),
  slug: z.string().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  active: z.boolean().nullable().optional(),
  closed: z.boolean().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  tags: z.array(GammaTagSchema).optional(),
  markets: z.array(GammaMarketSchema).optional(),
  seriesSlug: z.string().nullable().optional(),
});
export type GammaEvent = z.infer<typeof GammaEventSchema>;

export interface BookLevel {
  price: string;
  size: string;
}

export interface ExecutableBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; retryAfter?: number };
}
