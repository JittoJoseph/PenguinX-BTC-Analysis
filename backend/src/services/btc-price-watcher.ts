import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS } from "../types/index.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";
import { logAudit } from "../db/client.js";
import { marketNow } from "./market-clock.js";

const logger = createModuleLogger("btc-price-watcher");

/** 5m BTC markets settle on the Chainlink BTC/USD 30-second TWAP. */
const RTDS_TWAP_TOPIC = "crypto_prices_twap_thirty";

export class BtcPriceWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private currentPrice: number | null = null;
  private lastTimestamp: number = 0;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Wall-clock ms of the last tick; 0 until the first tick, so the watchdog
   *  never fires on initial connect. */
  private lastPriceReceivedMs: number = 0;
  private stalenessWatchdog: ReturnType<typeof setInterval> | null = null;

  private priceHistory: Array<{ price: number; timestamp: number }> = [];

  private static readonly PING_INTERVAL = 5_000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private static readonly BASE_RECONNECT_DELAY = 1_000;
  private static readonly HISTORY_TTL_MS = 60 * 60 * 1_000;
  private static readonly STALE_THRESHOLD_MS = 30_000;
  private static readonly STALE_CHECK_INTERVAL_MS = 10_000;
  private static readonly PRUNE_INTERVAL_TICKS = 60;
  private ticksSinceLastPrune = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.startStalenessWatchdog();
    logger.info("BTC price watcher started");
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.stalenessWatchdog) {
      clearInterval(this.stalenessWatchdog);
      this.stalenessWatchdog = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
    logger.info("BTC price watcher stopped");
  }

  getCurrentPrice(): BtcPriceData | null {
    if (this.currentPrice === null) return null;
    return { price: this.currentPrice, timestamp: this.lastTimestamp };
  }

  /** Wall-clock age of the last BTC price tick in milliseconds. */
  getPriceAgeMs(): number {
    if (this.lastPriceReceivedMs === 0) return -1; // never received
    return marketNow() - this.lastPriceReceivedMs;
  }

  /** True if the last price tick was received within STALE_THRESHOLD_MS. */
  isPriceFresh(): boolean {
    if (this.lastPriceReceivedMs === 0) return false;
    return this.getPriceAgeMs() < BtcPriceWatcher.STALE_THRESHOLD_MS;
  }

  /** Last known BTC/USD price at or before `targetMs` (wall-clock ms).
   *  Uses binary search — history is sorted ascending by timestamp. */
  getPriceAt(targetMs: number): number | null {
    const h = this.priceHistory;
    if (h.length === 0) return null;

    let lo = 0;
    let hi = h.length - 1;
    let bestIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (h[mid]!.timestamp <= targetMs) {
        bestIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (bestIdx >= 0) {
      const best = h[bestIdx]!;
      logger.debug(
        {
          targetMs,
          foundTs: best.timestamp,
          price: best.price,
          ageMs: marketNow() - best.timestamp,
        },
        "Found historical BTC price",
      );
      return best.price;
    }

    logger.debug(
      {
        targetMs,
        historySize: h.length,
        oldestTs: h[0]?.timestamp,
      },
      "No historical BTC price found for target time",
    );
    return null;
  }

  /** Ticks stamped within [fromMs, toMs], ascending. Empty once pruned past. */
  getHistoryBetween(
    fromMs: number,
    toMs: number,
  ): Array<{ price: number; timestamp: number }> {
    return this.priceHistory.filter(
      (t) => t.timestamp >= fromMs && t.timestamp <= toMs,
    );
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  getRealizedVol(windowMs: number): number | null {
    const cutoff = marketNow() - windowMs;
    const h = this.priceHistory;
    let sumSq = 0;
    let elapsedSec = 0;
    let count = 0;

    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1]!.timestamp < cutoff) break;
      const dp = h[i]!.price - h[i - 1]!.price;
      const dt = (h[i]!.timestamp - h[i - 1]!.timestamp) / 1000;
      if (dt > 0) {
        sumSq += dp * dp;
        elapsedSec += dt;
        count++;
      }
    }

    if (count < 10 || elapsedSec <= 0) return null;
    return Math.sqrt(sumSq / elapsedSec);
  }

  private setPrice(price: number, observedAtMs: number): void {
    this.lastPriceReceivedMs = marketNow();
    if (observedAtMs < this.lastTimestamp) return;

    this.currentPrice = price;
    this.lastTimestamp = observedAtMs;
    this.priceHistory.push({ price, timestamp: observedAtMs });

    this.ticksSinceLastPrune++;
    if (this.ticksSinceLastPrune >= BtcPriceWatcher.PRUNE_INTERVAL_TICKS) {
      this.ticksSinceLastPrune = 0;
      const cutoff = marketNow() - BtcPriceWatcher.HISTORY_TTL_MS;
      let pruneIdx = 0;
      while (
        pruneIdx < this.priceHistory.length &&
        this.priceHistory[pruneIdx]!.timestamp < cutoff
      ) {
        pruneIdx++;
      }
      if (pruneIdx > 0) this.priceHistory = this.priceHistory.slice(pruneIdx);
    }

    this.emit("btcPriceUpdate", {
      price,
      timestamp: observedAtMs,
    } satisfies BtcPriceData);
  }

  private startStalenessWatchdog(): void {
    if (this.stalenessWatchdog) return;

    this.stalenessWatchdog = setInterval(() => {
      if (!this.running) return;
      if (this.lastPriceReceivedMs === 0) return;

      const ageMs = marketNow() - this.lastPriceReceivedMs;
      if (ageMs < BtcPriceWatcher.STALE_THRESHOLD_MS) return;

      logger.warn(
        {
          ageMs,
          lastPrice: this.currentPrice,
          lastPriceAt: new Date(this.lastPriceReceivedMs).toISOString(),
          wsReadyState: this.ws?.readyState,
          staleThresholdMs: BtcPriceWatcher.STALE_THRESHOLD_MS,
        },
        "BTC price feed stale — force-reconnecting RTDS WebSocket",
      );

      logAudit(
        "warn",
        "SYSTEM",
        "BTC price feed stale (no ticks for >30s). Force-reconnecting to auto-heal.",
      ).catch(() => {});

      this.forceReconnect();
    }, BtcPriceWatcher.STALE_CHECK_INTERVAL_MS);
  }

  /** Force-close and reconnect immediately, skipping the exponential backoff. */
  private forceReconnect(): void {
    if (!this.running) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    this.cleanup();
    this.reconnectAttempt = 0;

    logger.info("Force-reconnecting RTDS WebSocket due to stale price feed");
    this.connect();
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.RTDS_WS);

      this.ws.on("open", () => {
        logger.info("RTDS WebSocket connected");
        this.reconnectAttempt = 0;

        const subscribeMsg = JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: RTDS_TWAP_TOPIC,
              type: "update",
              filters: '{"symbol":"btc/usd"}',
            },
          ],
        });
        this.ws!.send(subscribeMsg);
        logger.debug({ topic: RTDS_TWAP_TOPIC }, "RTDS subscribed");

        // RTDS keepalive: send text "PING" every 5s per Polymarket docs.
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send("PING");
          }
        }, BtcPriceWatcher.PING_INTERVAL);
      });

      this.ws.on("message", (rawData: WebSocket.Data) => {
        try {
          const text = rawData.toString().trim();
          if (text === "PONG" || text === "pong") return;

          const msg = JSON.parse(text) as Record<string, unknown>;
          const payload = msg["payload"] as Record<string, unknown> | undefined;
          if (
            msg["topic"] !== RTDS_TWAP_TOPIC ||
            payload?.["symbol"] !== "btc/usd" ||
            typeof payload["value"] !== "number" ||
            typeof payload["timestamp"] !== "number"
          ) {
            return;
          }

          this.setPrice(payload["value"], payload["timestamp"]);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.debug({ err: msg }, "RTDS message parse error");
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        logger.warn(
          { code, reason: reason.toString() },
          "RTDS WebSocket closed",
        );
        logAudit(
          "warn",
          "SYSTEM",
          `BTC RTDS WebSocket closed (code: ${code})`,
        ).catch(() => {});
        this.cleanup();
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error({ error: error.message }, "RTDS WebSocket error");
        logAudit(
          "error",
          "SYSTEM",
          `BTC RTDS WebSocket error: ${error.message}`,
        ).catch(() => {});
      });
    } catch (error) {
      logger.error({ error }, "Failed to create RTDS WebSocket");
      this.scheduleReconnect();
    }
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay =
      Math.min(
        BtcPriceWatcher.BASE_RECONNECT_DELAY *
          Math.pow(2, this.reconnectAttempt),
        BtcPriceWatcher.MAX_RECONNECT_DELAY,
      ) +
      Math.random() * 500;

    this.reconnectAttempt++;
    logger.info(
      { delay: Math.round(delay), attempt: this.reconnectAttempt },
      "RTDS reconnecting",
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

let instance: BtcPriceWatcher | null = null;
export function getBtcPriceWatcher(): BtcPriceWatcher {
  if (!instance) instance = new BtcPriceWatcher();
  return instance;
}
