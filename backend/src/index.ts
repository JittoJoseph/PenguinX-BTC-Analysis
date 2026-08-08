import { createModuleLogger } from "./utils/logger.js";
import { getConfig } from "./utils/config.js";
import { FIXED_POSITION_BUDGET_USD } from "./types/index.js";
import { connectDatabase } from "./db/client.js";
import { getBtcPriceWatcher } from "./services/btc-price-watcher.js";
import { getMarketClock } from "./services/market-clock.js";
import { getMarketOrchestrator } from "./services/market-orchestrator.js";
import { getApiServer } from "./services/api-server.js";

const logger = createModuleLogger("main");

async function main(): Promise<void> {
  logger.info("═══════════════════════════════════════════");
  logger.info("  PenguinX BTC Analysis — v4.0");
  logger.info("  Volatility-Barrier (z-score) Strategy");
  logger.info("═══════════════════════════════════════════");

  const config = getConfig();
  logger.info(
    {
      window: config.strategy.marketWindow,
      zEntryThreshold: config.strategy.zEntryThreshold,
      entryBand: `${config.strategy.entryPriceFloor}–${config.strategy.maxEntryPrice}`,
      entryFromWindowSec: config.strategy.entryFromWindowSeconds,
      sigmaWindowMs: config.strategy.sigmaWindowMs,
      startingCapital: config.portfolio.startingCapital,
      positionBudget: `$${FIXED_POSITION_BUDGET_USD} fixed (simulation)`,
      stopLoss: config.strategy.stopLossEnabled
        ? `${(config.strategy.stopLossDelta * 100).toFixed(0)}¢ below entry`
        : "disabled",
    },
    "Configuration loaded",
  );

  await connectDatabase();

  // Must precede anything that reasons about market time or stamps prices.
  await getMarketClock().start();

  const btcWatcher = getBtcPriceWatcher();
  btcWatcher.start();
  logger.info("BTC price watcher started");

  const orchestrator = getMarketOrchestrator();
  await orchestrator.start();

  const apiServer = getApiServer();
  await apiServer.start();

  logger.info("All systems operational ✓");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    try {
      apiServer.stop();
      orchestrator.stop();
      btcWatcher.stop();
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    }

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "Unhandled rejection");
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
