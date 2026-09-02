import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS, RTDS_RAW_TOPIC, WINDOW_CONFIG } from "../types/index.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";
import { logAudit } from "../db/client.js";
import { marketNow } from "./market-clock.js";

const logger = createModuleLogger("btc-price-watcher");

const TWAP_TOPIC = WINDOW_CONFIG.rtdsTwapTopic;

interface Tick {
  price: number;
  timestamp: number;
}

/**
 * Two Chainlink BTC/USD series from RTDS.
 *
 * `twap` is the settlement variable: markets resolve on the 60-second TWAP at
 * window end versus the same TWAP at window open.
 *
 * `raw` is the unsmoothed feed. It is what drives the TWAP forward, so it is the
 * only correct input both for volatility and for the roll-off term that says how
 * much of the closing TWAP is already fixed by prices that have happened.
 */
export class BtcPriceWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stalenessWatchdog: ReturnType<typeof setInterval> | null = null;

  private twapHistory: Tick[] = [];
  private rawHistory: Tick[] = [];
  private lastTwapTs = 0;
  private lastRawTs = 0;
  private lastTwapReceivedMs = 0;
  private lastRawReceivedMs = 0;

  private static readonly PING_INTERVAL = 5_000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private static readonly BASE_RECONNECT_DELAY = 1_000;
  private static readonly HISTORY_TTL_MS = 30 * 60 * 1_000;
  private static readonly STALE_THRESHOLD_MS = 30_000;
  private static readonly STALE_CHECK_INTERVAL_MS = 10_000;
  private static readonly PRUNE_INTERVAL_TICKS = 120;
  private static readonly MAX_TICK_GAP_MS = 4_000;
  private ticksSinceLastPrune = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.startStalenessWatchdog();
    logger.info({ twapTopic: TWAP_TOPIC, rawTopic: RTDS_RAW_TOPIC }, "BTC price watcher started");
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
    if (this.stalenessWatchdog) {
      clearInterval(this.stalenessWatchdog);
      this.stalenessWatchdog = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
    logger.info("BTC price watcher stopped");
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getCurrentTwap(): BtcPriceData | null {
    const last = this.twapHistory.at(-1);
    return last ? { price: last.price, timestamp: last.timestamp } : null;
  }

  getCurrentRaw(): BtcPriceData | null {
    const last = this.rawHistory.at(-1);
    return last ? { price: last.price, timestamp: last.timestamp } : null;
  }

  getTwapAgeMs(): number {
    return this.lastTwapReceivedMs === 0 ? -1 : marketNow() - this.lastTwapReceivedMs;
  }

  getRawAgeMs(): number {
    return this.lastRawReceivedMs === 0 ? -1 : marketNow() - this.lastRawReceivedMs;
  }

  isPriceFresh(): boolean {
    if (this.lastTwapReceivedMs === 0) return false;
    return this.getTwapAgeMs() < BtcPriceWatcher.STALE_THRESHOLD_MS;
  }

  /** Last TWAP observation at or before `targetMs`, or null if none is held. */
  getTwapAt(targetMs: number): number | null {
    return at(this.twapHistory, targetMs);
  }

  /** Last raw observation at or before `targetMs`, or null if none is held. */
  getRawAt(targetMs: number): number | null {
    return at(this.rawHistory, targetMs);
  }

  /**
   * Mean of the raw feed over [fromMs, toMs], trapezoidal over stored ticks.
   * Returns null when the range is not fully covered by ticks that are close
   * enough together to integrate, which is what keeps a feed gap from silently
   * producing a confident but wrong forecast.
   */
  getRawMean(fromMs: number, toMs: number): number | null {
    if (toMs <= fromMs) return null;
    const h = this.rawHistory;
    if (h.length < 2) return null;
    if (h[0]!.timestamp > fromMs || h.at(-1)!.timestamp < toMs) return null;

    let area = 0;
    for (let i = 1; i < h.length; i++) {
      const a = h[i - 1]!;
      const b = h[i]!;
      if (b.timestamp <= fromMs) continue;
      if (a.timestamp >= toMs) break;
      if (b.timestamp - a.timestamp > BtcPriceWatcher.MAX_TICK_GAP_MS) return null;

      const lo = Math.max(a.timestamp, fromMs);
      const hi = Math.min(b.timestamp, toMs);
      if (hi <= lo) continue;

      const span = b.timestamp - a.timestamp;
      const pLo = a.price + ((b.price - a.price) * (lo - a.timestamp)) / span;
      const pHi = a.price + ((b.price - a.price) * (hi - a.timestamp)) / span;
      area += ((pLo + pHi) / 2) * (hi - lo);
    }
    return area / (toMs - fromMs);
  }

  /** Per-second realized volatility of the raw feed, in dollars. */
  getRawSigma(windowMs: number): number | null {
    const cutoff = marketNow() - windowMs;
    const h = this.rawHistory;
    let sumSq = 0;
    let elapsedSec = 0;
    let count = 0;

    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1]!.timestamp < cutoff) break;
      const dp = h[i]!.price - h[i - 1]!.price;
      const dt = (h[i]!.timestamp - h[i - 1]!.timestamp) / 1000;
      if (dt > 0 && dt <= BtcPriceWatcher.MAX_TICK_GAP_MS / 1000) {
        sumSq += dp * dp;
        elapsedSec += dt;
        count++;
      }
    }
    if (count < 30 || elapsedSec <= 0) return null;
    return Math.sqrt(sumSq / elapsedSec);
  }

  private ingest(topic: string, price: number, observedAtMs: number): void {
    if (topic === TWAP_TOPIC) {
      this.lastTwapReceivedMs = marketNow();
      if (observedAtMs < this.lastTwapTs) return;
      this.lastTwapTs = observedAtMs;
      this.twapHistory.push({ price, timestamp: observedAtMs });
      this.prune();
      this.emit("twapUpdate", { price, timestamp: observedAtMs } satisfies BtcPriceData);
      return;
    }
    this.lastRawReceivedMs = marketNow();
    if (observedAtMs < this.lastRawTs) return;
    this.lastRawTs = observedAtMs;
    this.rawHistory.push({ price, timestamp: observedAtMs });
  }

  private prune(): void {
    if (++this.ticksSinceLastPrune < BtcPriceWatcher.PRUNE_INTERVAL_TICKS) return;
    this.ticksSinceLastPrune = 0;
    const cutoff = marketNow() - BtcPriceWatcher.HISTORY_TTL_MS;
    this.twapHistory = dropBefore(this.twapHistory, cutoff);
    this.rawHistory = dropBefore(this.rawHistory, cutoff);
  }

  private startStalenessWatchdog(): void {
    if (this.stalenessWatchdog) return;
    this.stalenessWatchdog = setInterval(() => {
      if (!this.running || this.lastTwapReceivedMs === 0) return;
      const ageMs = marketNow() - this.lastTwapReceivedMs;
      if (ageMs < BtcPriceWatcher.STALE_THRESHOLD_MS) return;

      logger.warn({ ageMs, wsReadyState: this.ws?.readyState }, "BTC feed stale — force-reconnecting");
      logAudit("warn", "SYSTEM", "BTC price feed stale (>30s). Force-reconnecting.").catch(() => {});
      this.forceReconnect();
    }, BtcPriceWatcher.STALE_CHECK_INTERVAL_MS);
  }

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
    this.connect();
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.RTDS_WS);

      this.ws.on("open", () => {
        logger.info("RTDS WebSocket connected");
        this.reconnectAttempt = 0;
        this.ws!.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              { topic: TWAP_TOPIC, type: "update", filters: '{"symbol":"btc/usd"}' },
              { topic: RTDS_RAW_TOPIC, type: "update", filters: '{"symbol":"btc/usd"}' },
            ],
          }),
        );
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
        }, BtcPriceWatcher.PING_INTERVAL);
      });

      this.ws.on("message", (rawData: WebSocket.Data) => {
        try {
          const text = rawData.toString().trim();
          if (text === "PONG" || text === "pong") return;

          const msg = JSON.parse(text) as Record<string, unknown>;
          const topic = msg["topic"];
          if (topic !== TWAP_TOPIC && topic !== RTDS_RAW_TOPIC) return;

          const payload = msg["payload"] as Record<string, unknown> | undefined;
          if (
            payload?.["symbol"] !== "btc/usd" ||
            typeof payload["value"] !== "number" ||
            typeof payload["timestamp"] !== "number"
          ) {
            return;
          }
          this.ingest(topic as string, payload["value"], payload["timestamp"]);
        } catch (err: unknown) {
          logger.debug({ err: err instanceof Error ? err.message : String(err) }, "RTDS parse error");
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        logger.warn({ code, reason: reason.toString() }, "RTDS WebSocket closed");
        this.cleanup();
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error({ error: error.message }, "RTDS WebSocket error");
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
        BtcPriceWatcher.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempt),
        BtcPriceWatcher.MAX_RECONNECT_DELAY,
      ) +
      Math.random() * 500;
    this.reconnectAttempt++;
    logger.info({ delay: Math.round(delay), attempt: this.reconnectAttempt }, "RTDS reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

function at(h: Tick[], targetMs: number): number | null {
  if (h.length === 0) return null;
  let lo = 0;
  let hi = h.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (h[mid]!.timestamp <= targetMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? h[best]!.price : null;
}

function dropBefore(h: Tick[], cutoff: number): Tick[] {
  let i = 0;
  while (i < h.length && h[i]!.timestamp < cutoff) i++;
  return i > 0 ? h.slice(i) : h;
}

let instance: BtcPriceWatcher | null = null;
export function getBtcPriceWatcher(): BtcPriceWatcher {
  if (!instance) instance = new BtcPriceWatcher();
  return instance;
}
