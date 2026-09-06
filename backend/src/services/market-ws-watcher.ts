import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import {
  POLY_URLS,
  type BookLevel,
  type ExecutableBook,
} from "../types/index.js";
import type {
  ClobWsMessage,
  BookUpdateEvent,
  TradeEvent,
  MarketResolvedEvent,
  MarketSubscriptionMessage,
  SubscriptionUpdateMessage,
} from "../interfaces/websocket-types.js";
import { logAudit } from "../db/client.js";

const logger = createModuleLogger("market-ws-watcher");

/** Price → aggregated size, per side. */
interface MaintainedBook {
  bids: Map<number, number>;
  asks: Map<number, number>;
  timestamp: number;
}

export class MarketWebSocketWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedTokens: Set<string> = new Set();
  private books: Map<string, MaintainedBook> = new Map();
  private lastTradeAt: Map<string, number> = new Map();
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private messageCount = 0;

  private static readonly PING_INTERVAL = 10000;
  private static readonly MAX_RECONNECT_DELAY = 60000;
  private static readonly BASE_RECONNECT_DELAY = 1000;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    logger.info("Market WebSocket watcher started");
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
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
    logger.info("Market WebSocket watcher stopped");
  }

  subscribe(tokenIds: string[]): void {
    const newTokens = tokenIds.filter((id) => !this.subscribedTokens.has(id));
    if (newTokens.length === 0) return;

    newTokens.forEach((id) => this.subscribedTokens.add(id));

    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: SubscriptionUpdateMessage = {
        assets_ids: newTokens,
        operation: "subscribe",
      };
      this.ws.send(JSON.stringify(msg));
      logger.info({ count: newTokens.length }, "Subscribed to new tokens");
    }
  }

  unsubscribe(tokenIds: string[]): void {
    tokenIds.forEach((id) => {
      this.subscribedTokens.delete(id);
      this.books.delete(id);
      this.lastTradeAt.delete(id);
    });

    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: SubscriptionUpdateMessage = {
        assets_ids: tokenIds,
        operation: "unsubscribe",
      };
      this.ws.send(JSON.stringify(msg));
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Executable depth for a token, or null if no snapshot has arrived yet. */
  getBook(tokenId: string): ExecutableBook | null {
    const book = this.books.get(tokenId);
    if (!book) return null;
    const levels = (m: Map<number, number>, desc: boolean): BookLevel[] =>
      Array.from(m.entries())
        .filter(([, size]) => size > 0)
        .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
        .map(([price, size]) => ({ price: String(price), size: String(size) }));
    return { bids: levels(book.bids, true), asks: levels(book.asks, false) };
  }

  /** Exchange time of the last real fill on this token, or null if none seen. */
  getLastTradeAt(tokenId: string): number | null {
    return this.lastTradeAt.get(tokenId) ?? null;
  }

  getBestBid(tokenId: string): number | null {
    return this.bestOf(this.books.get(tokenId)?.bids, true);
  }

  getBestAsk(tokenId: string): number | null {
    return this.bestOf(this.books.get(tokenId)?.asks, false);
  }

  getStats() {
    return {
      connected: this.isConnected(),
      subscribedTokens: this.subscribedTokens.size,
      maintainedBooks: this.books.size,
      messageCount: this.messageCount,
      reconnectAttempts: this.reconnectAttempt,
    };
  }

  private bestOf(
    m: Map<number, number> | undefined,
    max: boolean,
  ): number | null {
    if (!m) return null;
    let best: number | null = null;
    for (const [price, size] of m) {
      if (size <= 0) continue;
      if (best === null || (max ? price > best : price < best)) best = price;
    }
    return best;
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.CLOB_WS);

      this.ws.on("open", () => {
        logger.info("CLOB WebSocket connected");
        this.reconnectAttempt = 0;
        this.emit("connected");

        if (this.subscribedTokens.size > 0) {
          const msg: MarketSubscriptionMessage = {
            assets_ids: Array.from(this.subscribedTokens),
            type: "market",
            custom_feature_enabled: true,
          };
          this.ws!.send(JSON.stringify(msg));
          logger.info(
            { tokenCount: this.subscribedTokens.size },
            "Sent initial subscription with custom_feature_enabled",
          );
        }

        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send("PING");
          }
        }, MarketWebSocketWatcher.PING_INTERVAL);
      });

      this.ws.on("message", (rawData: WebSocket.Data) => {
        this.messageCount++;
        try {
          const text = rawData.toString();
          if (text === "PONG" || text.startsWith("INVALID")) return;

          const msg: ClobWsMessage = JSON.parse(text);
          this.handleMessage(msg);
        } catch {
          /* ignore parse errors */
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        logger.warn(
          { code, reason: reason.toString() },
          "CLOB WebSocket closed",
        );
        logAudit(
          "warn",
          "SYSTEM",
          `CLOB WebSocket closed (code: ${code})`,
        ).catch(() => {});
        this.cleanup();
        this.emit("disconnected", { code, reason: reason.toString() });
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error({ error: error.message }, "CLOB WebSocket error");
        logAudit(
          "error",
          "SYSTEM",
          `CLOB WebSocket error: ${error.message}`,
        ).catch(() => {});
        this.emit("error", error);
      });
    } catch (error) {
      logger.error({ error }, "Failed to create CLOB WebSocket");
      this.scheduleReconnect();
    }
  }

  private handleMessage(msg: ClobWsMessage): void {
    const ts =
      typeof msg.timestamp === "string"
        ? parseInt(msg.timestamp, 10)
        : (msg.timestamp ?? Date.now());

    switch (msg.event_type) {
      case "book":
        if (msg.asset_id && msg.bids && msg.asks) {
          this.books.set(msg.asset_id, {
            bids: toLevelMap(msg.bids),
            asks: toLevelMap(msg.asks),
            timestamp: ts,
          });
          this.emitBookUpdate(msg.asset_id, ts);
        }
        break;

      case "price_change":
        if (msg.price_changes) {
          const touched = new Set<string>();
          for (const pc of msg.price_changes) {
            const book = this.books.get(pc.asset_id);
            if (!book) continue; // no snapshot yet; the next `book` resyncs us
            const side = pc.side === "BUY" ? book.bids : book.asks;
            const price = parseFloat(pc.price);
            const size = parseFloat(pc.size);
            if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
            if (size > 0) side.set(price, size);
            else side.delete(price);
            book.timestamp = ts;
            touched.add(pc.asset_id);
          }
          for (const tokenId of touched) this.emitBookUpdate(tokenId, ts);
        }
        break;

      case "last_trade_price":
        if (msg.asset_id && msg.price) {
          const price = parseFloat(msg.price);
          if (!Number.isFinite(price)) break;
          this.lastTradeAt.set(msg.asset_id, ts);
          this.emit("trade", {
            tokenId: msg.asset_id,
            price,
            timestamp: ts,
          } satisfies TradeEvent);
        }
        break;

      case "market_resolved":
        if (msg.market && msg.winning_asset_id && msg.winning_outcome) {
          logger.info(
            {
              market: msg.market,
              winner: msg.winning_outcome,
              winnerAsset: msg.winning_asset_id,
            },
            "Market resolved via WebSocket",
          );
          this.emit("marketResolved", {
            marketId: msg.id ?? "",
            conditionId: msg.market,
            winningAssetId: msg.winning_asset_id,
            winningOutcome: msg.winning_outcome,
            timestamp: ts,
          } satisfies MarketResolvedEvent);
        }
        break;
    }
  }

  /** Announce new executable state; best bid/ask always derive from the book. */
  private emitBookUpdate(tokenId: string, timestamp: number): void {
    const bestBid = this.getBestBid(tokenId);
    const bestAsk = this.getBestAsk(tokenId);
    this.emit("bookUpdate", {
      tokenId,
      bestBid,
      bestAsk,
      timestamp,
    } satisfies BookUpdateEvent);
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    // A reconnect replays fresh snapshots; stale depth must never be executable.
    this.books.clear();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay =
      Math.min(
        MarketWebSocketWatcher.BASE_RECONNECT_DELAY *
          Math.pow(2, this.reconnectAttempt),
        MarketWebSocketWatcher.MAX_RECONNECT_DELAY,
      ) +
      Math.random() * 300;

    this.reconnectAttempt++;
    logger.info(
      { delay: Math.round(delay), attempt: this.reconnectAttempt },
      "CLOB reconnecting",
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

function toLevelMap(levels: BookLevel[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of levels) {
    const price = parseFloat(l.price);
    const size = parseFloat(l.size);
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
      m.set(price, size);
    }
  }
  return m;
}

let instance: MarketWebSocketWatcher | null = null;
export function getMarketWebSocketWatcher(): MarketWebSocketWatcher {
  if (!instance) instance = new MarketWebSocketWatcher();
  return instance;
}
