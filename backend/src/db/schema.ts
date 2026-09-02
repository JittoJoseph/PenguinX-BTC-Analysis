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
    twapAtEntry: decimal("twap_at_entry", { precision: 18, scale: 2 }),
    rawAtEntry: decimal("raw_at_entry", { precision: 18, scale: 2 }),
    strike: decimal("strike", { precision: 18, scale: 2 }),
    forecastSettlement: decimal("forecast_settlement", {
      precision: 18,
      scale: 2,
    }),
    forecastMarginUsd: decimal("forecast_margin_usd", {
      precision: 12,
      scale: 4,
    }),
    forecastSdUsd: decimal("forecast_sd_usd", { precision: 12, scale: 4 }),
    modelProb: decimal("model_prob", { precision: 8, scale: 6 }),
    modelEdge: decimal("model_edge", { precision: 8, scale: 6 }),
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
