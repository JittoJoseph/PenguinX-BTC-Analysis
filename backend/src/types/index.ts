import { z } from "zod";

export const MARKET_WINDOWS = ["5M", "15M", "1H", "4H", "1D"] as const;
export type MarketWindow = (typeof MARKET_WINDOWS)[number];

export interface WindowConfig {
  tagSlug: string;
  slugPrefix: string;
  seriesSlug: string;
  durationMs: number;
  category: string;
  label: string;
}

export const WINDOW_CONFIGS: Record<MarketWindow, WindowConfig> = {
  "5M": {
    tagSlug: "5M",
    slugPrefix: "btc-updown-5m",
    seriesSlug: "btc-up-or-down-5m",
    durationMs: 5 * 60 * 1000,
    category: "btc-5m",
    label: "BTC 5-Minute",
  },
  "15M": {
    tagSlug: "15M",
    slugPrefix: "btc-updown-15m",
    seriesSlug: "btc-up-or-down-15m",
    durationMs: 15 * 60 * 1000,
    category: "btc-15m",
    label: "BTC 15-Minute",
  },
  "1H": {
    tagSlug: "1H",
    slugPrefix: "btc-updown-1h",
    seriesSlug: "btc-up-or-down-1h",
    durationMs: 60 * 60 * 1000,
    category: "btc-1h",
    label: "BTC 1-Hour",
  },
  "4H": {
    tagSlug: "4H",
    slugPrefix: "btc-updown-4h",
    seriesSlug: "btc-up-or-down-4h",
    durationMs: 4 * 60 * 60 * 1000,
    category: "btc-4h",
    label: "BTC 4-Hour",
  },
  "1D": {
    tagSlug: "1D",
    slugPrefix: "btc-updown-1d",
    seriesSlug: "btc-up-or-down-1d",
    durationMs: 24 * 60 * 60 * 1000,
    category: "btc-1d",
    label: "BTC 1-Day",
  },
};

export const POLY_URLS = {
  GAMMA_API_BASE: "https://gamma-api.polymarket.com",
  CLOB_BASE: "https://clob.polymarket.com",
  CLOB_WS: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  RTDS_WS: "wss://ws-live-data.polymarket.com",
} as const;

// Polymarket crypto (5M/15M) fee per share = RATE·(p·(1-p))^EXPONENT, 20% maker rebate
export const CRYPTO_FEE = {
  RATE: 0.25,
  EXPONENT: 2,
  MAKER_REBATE_PERCENT: 0.2,
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
    marketWindow: z.enum(MARKET_WINDOWS),
    entryFromWindowSeconds: z.number().min(5).max(300),
    entryPriceFloor: z.number().min(0).max(0.99),
    maxEntryPrice: z.number().min(0.5).max(0.999),
    zEntryThreshold: z.number().min(0.5).max(20),
    sigmaWindowMs: z.number().min(10_000).max(600_000),
    minEntryEdge: z.number().min(0).max(0.5),
    stopLossEnabled: z.boolean(),
    stopLossDelta: z.number().min(0).max(1),
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
