import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  decimal,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const markets = pgTable(
  "markets",
  {
    id: text("id").primaryKey(),
    conditionId: text("condition_id"),
    slug: text("slug"),
    question: text("question"),
    clobTokenIds: jsonb("clob_token_ids"),
    outcomes: jsonb("outcomes"),
    windowType: text("window_type").notNull(),
    category: text("category").notNull(),
    endDate: text("end_date"),
    targetPrice: decimal("target_price", { precision: 18, scale: 2 }),
    active: boolean("active").default(true).notNull(),
    metadata: jsonb("metadata"),
    lastFetchedAt: timestamp("last_fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index("markets_slug_idx").on(table.slug),
    activeIdx: index("markets_active_idx").on(table.active),
    endDateIdx: index("markets_end_date_idx").on(table.endDate),
    windowTypeIdx: index("markets_window_type_idx").on(table.windowType),
  }),
);

export const portfolio = pgTable("portfolio", {
  id: integer("id").primaryKey().default(1),
  initialCapital: decimal("initial_capital", {
    precision: 18,
    scale: 8,
  }).notNull(),
  cashBalance: decimal("cash_balance", { precision: 18, scale: 8 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const simulatedTrades = pgTable(
  "simulated_trades",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    marketId: text("market_id"),
    tokenId: text("token_id"),
    marketCategory: text("market_category"),
    windowType: text("window_type"),
    side: text("side").default("BUY").notNull(),
    outcomeLabel: text("outcome_label"),
    orderType: text("order_type").default("FAK").notNull(),
    entryTs: timestamp("entry_ts").notNull(),
    entryPrice: decimal("entry_price", { precision: 18, scale: 8 }).notNull(),
    entryShares: decimal("entry_shares", { precision: 18, scale: 8 }).notNull(),
    positionBudget: decimal("position_budget", {
      precision: 18,
      scale: 8,
    }).notNull(),
    actualCost: decimal("actual_cost", { precision: 18, scale: 8 }).notNull(),
    entryFees: decimal("entry_fees", { precision: 18, scale: 8 }).default("0"),
    fillStatus: text("fill_status").default("FULL"),
    btcPriceAtEntry: decimal("btc_price_at_entry", { precision: 18, scale: 2 }),
    btcTargetPrice: decimal("btc_target_price", { precision: 18, scale: 2 }),
    btcDistanceUsd: decimal("btc_distance_usd", {
      precision: 10,
      scale: 4,
    }),
    // z = signedDistance / (sigma·√secondsLeft); sigma in $/s
    entryZ: decimal("entry_z", { precision: 10, scale: 4 }),
    entrySigma: decimal("entry_sigma", { precision: 18, scale: 8 }),
    secondsToEnd: decimal("seconds_to_end", { precision: 8, scale: 2 }),
    minPriceDuringPosition: decimal("min_price_during_position", {
      precision: 18,
      scale: 8,
    }),
    exitPrice: decimal("exit_price", { precision: 18, scale: 8 }),
    exitTs: timestamp("exit_ts"),
    exitOutcome: text("exit_outcome"),
    exitReason: text("exit_reason"),
    realizedPnl: decimal("realized_pnl", { precision: 18, scale: 8 }),
    status: text("status").default("OPEN").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    marketIdIdx: index("st_market_id_idx").on(table.marketId),
    statusIdx: index("st_status_idx").on(table.status),
    entryTsIdx: index("st_entry_ts_idx").on(table.entryTs),
    statusEntryTsIdx: index("st_status_entry_ts_idx").on(
      table.status,
      table.entryTs,
    ),
    uqOpenTradePerToken: uniqueIndex("uq_open_trade_per_market_token")
      .on(table.marketId, table.tokenId)
      .where(sql`status = 'OPEN'`),
  }),
);

export const marketRegimeData = pgTable(
  "market_regime_data",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    marketId: text("market_id").notNull(),
    slug: text("slug"),
    windowType: text("window_type").notNull(),
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),

    // BTC over the window, measured from our own tick history.
    btcStartPrice: decimal("btc_start_price", { precision: 18, scale: 2 }),
    btcEndPrice: decimal("btc_end_price", { precision: 18, scale: 2 }),
    btcHighPrice: decimal("btc_high_price", { precision: 18, scale: 2 }),
    btcLowPrice: decimal("btc_low_price", { precision: 18, scale: 2 }),
    /** Realized per-second volatility over the window, in $/s. */
    btcSigmaPerSec: decimal("btc_sigma_per_sec", { precision: 18, scale: 8 }),
    /** Times BTC crossed the start price — how choppy the window was. */
    btcStrikeCrossings: integer("btc_strike_crossings"),
    /** Ticks the measurements above are based on; low values mean low trust. */
    btcTickCount: integer("btc_tick_count"),

    winningOutcome: text("winning_outcome"),
    tradeTaken: boolean("trade_taken").notNull(),
    /** WIN or LOSS, null when no trade was taken. */
    outcome: text("outcome"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    marketIdIdx: uniqueIndex("mrd_market_id_idx").on(table.marketId),
    windowEndIdx: index("mrd_window_end_idx").on(table.windowEnd),
  }),
);

export const auditLogs = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    level: text("level").notNull(),
    category: text("category").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    levelIdx: index("al_level_idx").on(table.level),
    categoryIdx: index("al_category_idx").on(table.category),
    createdAtIdx: index("al_created_at_idx").on(table.createdAt),
  }),
);
