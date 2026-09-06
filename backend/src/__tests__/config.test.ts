import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ConfigSchema } from "../types/index.js";
import { loadConfig } from "../utils/config.js";

const REQUIRED = {
  SUPABASE_DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  ADMIN_PASSWORD: "x",
};

const STRATEGY_KEYS = [
  "ENTRY_WINDOW_OPEN_SECONDS",
  "ENTRY_WINDOW_CLOSE_SECONDS",
  "MIN_ENTRY_PRICE",
  "MAX_ENTRY_PRICE",
  "DECIDED_FLOOR_MULTIPLIER",
  "DECIDED_SD_MULTIPLE",
  "SIGMA_WINDOW_MS",
  "MAX_RAW_STALENESS_MS",
  "STOP_LOSS_FRACTION",
  "EXECUTION_LATENCY_MS",
  "MARKET_LIVENESS_MS",
  "SCAN_INTERVAL_MS",
  "STARTING_CAPITAL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of [...STRATEGY_KEYS, ...Object.keys(REQUIRED)]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const freshLoadConfig = async () => loadConfig();

describe("configuration", () => {
  it("built-in defaults satisfy the schema", async () => {
    const config = await freshLoadConfig();
    expect(ConfigSchema.safeParse(config).success).toBe(true);
  });

  it("the shipped .env.example satisfies the schema", async () => {
    const text = readFileSync(`${import.meta.dirname}/../../.env.example`, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && STRATEGY_KEYS.includes(m[1]!)) process.env[m[1]!] = m[2]!.trim();
    }
    const config = await freshLoadConfig();
    expect(ConfigSchema.safeParse(config).success).toBe(true);
  });

  it("entry window brackets the calibrated horizon", async () => {
    const config = await freshLoadConfig();
    expect(config.strategy.entryWindowOpenSeconds).toBeLessThanOrEqual(300);
    expect(config.strategy.entryWindowCloseSeconds).toBeLessThan(
      config.strategy.entryWindowOpenSeconds,
    );
  });

  it("rejects an entry window the floor table cannot cover", () => {
    const result = ConfigSchema.shape.strategy.safeParse({
      entryWindowOpenSeconds: 2000,
      entryWindowCloseSeconds: 5,
      minEntryPrice: 0.15,
      maxEntryPrice: 0.85,
      decidedFloorMultiplier: 0.4,
      decidedSdMultiple: 3,
      sigmaWindowMs: 180_000,
      maxRawStalenessMs: 5_000,
      stopLossFraction: 0.35,
      scanIntervalMs: 60_000,
      executionLatencyMs: 50,
      marketLivenessMs: 120_000,
    });
    expect(result.success).toBe(false);
  });
});
