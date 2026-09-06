import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "../utils/config.js";
import { createModuleLogger } from "../utils/logger.js";
import * as schema from "./schema.js";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

const logger = createModuleLogger("database");

let client: postgres.Sql | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!db) {
    const config = getConfig();
    client = postgres(config.db.url, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 10,
    });
    db = drizzle(client, { schema, logger: false });
    logger.info("Drizzle database client initialized");
  }
  return db;
}

export async function connectDatabase(): Promise<void> {
  const database = getDb();
  await database.execute(sql`SELECT 1`);
  logger.info("Database connection established");
}

export async function insertMarketIfNew(
  id: string,
  data: {
    conditionId?: string;
    slug?: string;
    question?: string;
    clobTokenIds?: string[];
    outcomes?: string[];
    windowType: string;
    category: string;
    endDate?: string | null;
    targetPrice?: number | null;
    active?: boolean;
    metadata?: unknown;
  },
): Promise<boolean> {
  const database = getDb();

  const record = {
    id,
    conditionId: data.conditionId || null,
    slug: data.slug || null,
    question: data.question || null,
    clobTokenIds: data.clobTokenIds as any,
    outcomes: data.outcomes as any,
    windowType: data.windowType,
    category: data.category,
    endDate: data.endDate || null,
    targetPrice: data.targetPrice?.toString() ?? null,
    active: data.active ?? true,
    metadata: data.metadata as any,
  };

  const result = await database
    .insert(schema.markets)
    .values(record)
    .onConflictDoNothing({ target: schema.markets.id })
    .returning({ id: schema.markets.id });

  return result.length > 0;
}

export async function loadOpenTradesWithMarkets() {
  const database = getDb();
  const rows = await database
    .select({
      trade: schema.simulatedTrades,
      marketEndDate: schema.markets.endDate,
    })
    .from(schema.simulatedTrades)
    .leftJoin(
      schema.markets,
      eq(schema.simulatedTrades.marketId, schema.markets.id),
    )
    .where(eq(schema.simulatedTrades.status, "OPEN"));
  return rows;
}

export async function createSimulatedTrade(data: {
  marketId?: string;
  tokenId: string;
  marketCategory?: string;
  windowType?: string;
  outcomeLabel?: string;
  entryTs: Date;
  entryPrice: string;
  entryShares: string;
  positionBudget: string;
  actualCost: string;
  entryFees?: string;
  fillStatus?: string;
  twapAtEntry?: number;
  rawAtEntry?: number;
  strike?: number;
  forecastSettlement?: number;
  forecastMarginUsd?: number;
  forecastSdUsd?: number;
  decidedFloorUsd?: number;
  secondsToEnd?: number;
  minPriceDuringPosition?: string;
}) {
  const database = getDb();
  const result = await database
    .insert(schema.simulatedTrades)
    .values({
      marketId: data.marketId || null,
      tokenId: data.tokenId,
      marketCategory: data.marketCategory || null,
      windowType: data.windowType || null,
      side: "BUY",
      orderType: "FAK",
      outcomeLabel: data.outcomeLabel || null,
      entryTs: data.entryTs,
      entryPrice: data.entryPrice,
      entryShares: data.entryShares,
      positionBudget: data.positionBudget,
      actualCost: data.actualCost,
      entryFees: data.entryFees ?? "0",
      fillStatus: data.fillStatus ?? "FULL",
      twapAtEntry: data.twapAtEntry?.toString() ?? null,
      rawAtEntry: data.rawAtEntry?.toString() ?? null,
      strike: data.strike?.toString() ?? null,
      forecastSettlement: data.forecastSettlement?.toString() ?? null,
      forecastMarginUsd: data.forecastMarginUsd?.toString() ?? null,
      forecastSdUsd: data.forecastSdUsd?.toString() ?? null,
      decidedFloorUsd: data.decidedFloorUsd?.toString() ?? null,
      secondsToEnd: data.secondsToEnd?.toString() ?? null,
      minPriceDuringPosition: data.minPriceDuringPosition ?? null,
      status: "OPEN",
    })
    .returning();
  return result[0];
}

/** Monotonic: concurrent unordered writes can never raise the recorded minimum. */
export async function updateTradeMinPrice(id: string, minPrice: string) {
  const database = getDb();
  await database
    .update(schema.simulatedTrades)
    .set({ minPriceDuringPosition: minPrice, updatedAt: new Date() })
    .where(
      and(
        eq(schema.simulatedTrades.id, id),
        or(
          isNull(schema.simulatedTrades.minPriceDuringPosition),
          gt(schema.simulatedTrades.minPriceDuringPosition, minPrice),
        ),
      ),
    );
}

export async function resolveTrade(
  id: string,
  outcome: "WIN" | "LOSS",
  realizedPnl: string,
  exitPrice?: string,
  extras?: {
    exitReason?: "RESOLUTION" | "STOP_LOSS";
  },
) {
  const database = getDb();
  const finalExitPrice = exitPrice ?? (outcome === "WIN" ? "1" : "0");

  const result = await database
    .update(schema.simulatedTrades)
    .set({
      exitOutcome: outcome,
      exitPrice: finalExitPrice,
      exitTs: new Date(),
      realizedPnl,
      status: "SETTLED",
      updatedAt: new Date(),
      ...(extras?.exitReason ? { exitReason: extras.exitReason } : {}),
    })
    .where(eq(schema.simulatedTrades.id, id))
    .returning();
  return result[0];
}

export async function logAudit(
  level: "info" | "warn" | "error",
  category: string,
  message: string,
  metadata?: unknown,
) {
  const database = getDb();
  try {
    await database.insert(schema.auditLogs).values({
      level,
      category,
      message,
      metadata: metadata as any,
    });
  } catch (e) {
    logger.error({ error: e }, "Failed to write audit log");
  }
}

export async function getPortfolio() {
  const database = getDb();
  const rows = await database
    .select()
    .from(schema.portfolio)
    .where(eq(schema.portfolio.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

export async function initPortfolio(startingCapital: number) {
  const database = getDb();
  const existing = await getPortfolio();
  if (existing) return existing;

  const result = await database
    .insert(schema.portfolio)
    .values({
      id: 1,
      initialCapital: startingCapital.toString(),
      cashBalance: startingCapital.toString(),
    })
    .returning();
  return result[0];
}

export async function updateCashBalance(newBalance: string) {
  const database = getDb();
  const result = await database
    .update(schema.portfolio)
    .set({ cashBalance: newBalance, updatedAt: new Date() })
    .where(eq(schema.portfolio.id, 1))
    .returning();
  return result[0];
}

export async function wipeAndResetPortfolio(startingCapital: number) {
  const database = getDb();
  await database.delete(schema.simulatedTrades);
  await database.delete(schema.auditLogs);
  await database.delete(schema.portfolio);
  const result = await database
    .insert(schema.portfolio)
    .values({
      id: 1,
      initialCapital: startingCapital.toString(),
      cashBalance: startingCapital.toString(),
    })
    .returning();
  return result[0];
}
