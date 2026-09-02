import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { WINDOW_CONFIG, type WindowConfig } from "../types/index.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";
import { marketNow } from "./market-clock.js";

const logger = createModuleLogger("market-scanner");

/**
 * Discovers BTC window markets by deterministic slug. BTC 15-minute slugs follow
 * `btc-updown-15m-{unixWindowStart}`, where the window start is aligned to a round
 * boundary: `Math.floor(now / 900) * 900`. Each scan fetches recent-past, current,
 * and upcoming window slugs and emits any newly-seen market.
 */
export class MarketScanner extends EventEmitter {
  private client: PolymarketClient;
  private scanInterval: NodeJS.Timeout | null = null;
  private discoveredCount = 0;
  private running = false;
  private seenMarketIds = new Map<string, number>();

  private static readonly LOOKAHEAD_WINDOWS = 3;
  private static readonly LOOKBEHIND_WINDOWS = 2;

  constructor() {
    super();
    this.client = getPolymarketClient();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const config = getConfig();
    const windowConfig = WINDOW_CONFIG;

    logger.info(
      {
        slugPrefix: windowConfig.slugPrefix,
        durationMs: windowConfig.durationMs,
        scanIntervalMs: config.strategy.scanIntervalMs,
        lookahead: MarketScanner.LOOKAHEAD_WINDOWS,
        lookbehind: MarketScanner.LOOKBEHIND_WINDOWS,
      },
      "Starting market scanner (deterministic slug mode)",
    );

    // Initial scan
    await this.scan();

    // Periodic scanning
    this.scanInterval = setInterval(() => {
      this.scan().catch((err) =>
        logger.error({ error: err }, "Scan iteration failed"),
      );
    }, config.strategy.scanIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    logger.info("Market scanner stopped");
  }

  getDiscoveredCount(): number {
    return this.discoveredCount;
  }

  private computeWindowSlugs(windowConfig: WindowConfig): string[] {
    // Window boundaries are Polymarket's, so they must be derived from its clock.
    const nowSeconds = Math.floor(marketNow() / 1000);
    const durationSeconds = windowConfig.durationMs / 1000;
    const currentWindowStart =
      Math.floor(nowSeconds / durationSeconds) * durationSeconds;

    const slugs: string[] = [];

    for (let i = MarketScanner.LOOKBEHIND_WINDOWS; i > 0; i--) {
      const windowStart = currentWindowStart - i * durationSeconds;
      slugs.push(`${windowConfig.slugPrefix}-${windowStart}`);
    }

    for (let i = 0; i < MarketScanner.LOOKAHEAD_WINDOWS; i++) {
      const windowStart = currentWindowStart + i * durationSeconds;
      slugs.push(`${windowConfig.slugPrefix}-${windowStart}`);
    }

    return slugs;
  }

  async scan(): Promise<void> {
    const config = getConfig();
    const windowConfig = WINDOW_CONFIG;

    try {
      const slugs = this.computeWindowSlugs(windowConfig);

      logger.debug({ slugs }, "Scanning for markets by deterministic slugs");

      const markets = await this.client.getMarkets({ slug: slugs });

      let newMarketsFound = 0;

      for (const market of markets) {
        if (!market.slug?.startsWith(windowConfig.slugPrefix)) continue;
        if (market.closed) continue;

        if (this.markSeen(market.id)) {
          this.discoveredCount++;
          newMarketsFound++;
          this.emit("newMarket", { market });
        }
      }

      if (newMarketsFound > 0) {
        logger.info(
          { newMarketsFound, total: this.discoveredCount, slugs },
          "Scan complete — new markets found",
        );
      } else {
        logger.debug(
          { returned: markets.length, slugs },
          "Scan complete — no new markets",
        );
      }
    } catch (error) {
      logger.error({ error }, "Market scan failed");
    }
  }

  /** Records a market id and returns true only the first time it is seen. */
  private markSeen(marketId: string): boolean {
    const now = Date.now();
    if (this.seenMarketIds.has(marketId)) {
      this.seenMarketIds.set(marketId, now);
      return false;
    }
    this.seenMarketIds.set(marketId, now);

    if (this.seenMarketIds.size > 100) {
      const threshold = now - 60 * 60 * 1000;
      for (const [id, lastSeen] of this.seenMarketIds.entries()) {
        if (lastSeen < threshold) this.seenMarketIds.delete(id);
      }
    }

    return true;
  }
}

let instance: MarketScanner | null = null;
export function getMarketScanner(): MarketScanner {
  if (!instance) instance = new MarketScanner();
  return instance;
}
