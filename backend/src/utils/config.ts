import { Config, ConfigSchema } from "../types/index.js";
import dotenv from "dotenv";

dotenv.config();

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

function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === "true";
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
      marketWindow: env("MARKET_WINDOW", "5M"),
      entryFromWindowSeconds: envNum("ENTRY_FROM_WINDOW_SECONDS", 30),
      entryPriceFloor: envNum("ENTRY_PRICE_FLOOR", 0.6),
      maxEntryPrice: envNum("MAX_ENTRY_PRICE", 0.98),
      zEntryThreshold: envNum("Z_ENTRY_THRESHOLD", 3.0),
      sigmaWindowMs: envNum("SIGMA_WINDOW_MS", 60_000),
      minEntryEdge: envNum("MIN_ENTRY_EDGE", 0),
      stopLossEnabled: envBool("STOP_LOSS_ENABLED", true),
      stopLossDelta: envNum("STOP_LOSS_DELTA", 0.2),
      executionLatencyMs: envNum("EXECUTION_LATENCY_MS", 250),
      scanIntervalMs: envNum("SCAN_INTERVAL_MS", 60_000),
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
