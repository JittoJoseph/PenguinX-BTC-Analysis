import { Config, ConfigSchema } from "../types/index.js";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

function env(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envNum(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable: ${key}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const rawConfig = {
    db: {
      url: env("SUPABASE_DATABASE_URL"),
    },
    portfolio: {
      startingCapital: envNum("STARTING_CAPITAL", 100),
    },
    strategy: {
      entryWindowOpenSeconds: envNum("ENTRY_WINDOW_OPEN_SECONDS", 300),
      entryWindowCloseSeconds: envNum("ENTRY_WINDOW_CLOSE_SECONDS", 5),
      minEntryPrice: envNum("MIN_ENTRY_PRICE", 0.15),
      maxEntryPrice: envNum("MAX_ENTRY_PRICE", 0.85),
      decidedFloorMultiplier: envNum("DECIDED_FLOOR_MULTIPLIER", 0.4),
      decidedSdMultiple: envNum("DECIDED_SD_MULTIPLE", 3),
      sigmaWindowMs: envNum("SIGMA_WINDOW_MS", 180_000),
      maxRawStalenessMs: envNum("MAX_RAW_STALENESS_MS", 5_000),
      stopLossFraction: envNum("STOP_LOSS_FRACTION", 0.35),
      executionLatencyMs: envNum("EXECUTION_LATENCY_MS", 50),
      scanIntervalMs: envNum("SCAN_INTERVAL_MS", 60_000),
      marketLivenessMs: envNum("MARKET_LIVENESS_MS", 120_000),
    },
    admin: {
      password: env("ADMIN_PASSWORD"),
    },
    server: {
      port: envNum("PORT", 4000),
      host: env("HOST", "0.0.0.0"),
    },
    logging: {
      level: env("LOG_LEVEL", "info"),
    },
    env: env("NODE_ENV", "development"),
  };

  return ConfigSchema.parse(rawConfig);
}

let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
