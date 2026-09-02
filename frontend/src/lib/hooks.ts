"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getApiClient, getWsClient } from "./api-client";
import { formatPnl } from "./utils";
import { marketNow } from "./market-time";
import type {
  SimulatedTrade,
  LiveState,
  LiveMarketInfo,
  DiscoveredMarket,
  PerformanceMetrics,
  AuditLog,
  ActivityEntry,
  WsMessage,
} from "./types";

const PAGE_SIZE = 25;

export function useTrades(status?: string) {
  const [trades, setTrades] = useState<SimulatedTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // DB rows fetched; WS-prepended rows don't count toward offset
  const dbFetchedRef = useRef(0);

  const fetchTrades = useCallback(async () => {
    try {
      setLoading(true);
      dbFetchedRef.current = 0;
      const api = getApiClient();
      const response = await api.getTrades({
        status,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setTrades(response);
      dbFetchedRef.current = response.length;
      setHasMore(response.length === PAGE_SIZE);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [status]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    try {
      setLoadingMore(true);
      const api = getApiClient();
      const response = await api.getTrades({
        status,
        limit: PAGE_SIZE,
        offset: dbFetchedRef.current,
      });
      dbFetchedRef.current += response.length;
      setTrades((prev) => {
        const ids = new Set(prev.map((t) => t.id));
        return [...prev, ...response.filter((t) => !ids.has(t.id))];
      });
      setHasMore(response.length === PAGE_SIZE);
    } catch {
      // keep existing trades on error
    } finally {
      setLoadingMore(false);
    }
  }, [status, loadingMore]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const unsubOpened = ws.on("tradeOpened", (msg: WsMessage) => {
      const trade = (msg.data as { trade?: SimulatedTrade })?.trade;
      if (!trade) return;
      setTrades((prev) => {
        if (prev.some((t) => t.id === trade.id)) return prev;
        return [trade, ...prev];
      });
    });

    const unsubResolved = ws.on("tradeResolved", (msg: WsMessage) => {
      const trade = (msg.data as { trade?: SimulatedTrade })?.trade;
      if (!trade) return;
      setTrades((prev) => prev.map((t) => (t.id === trade.id ? trade : t)));
    });

    return () => {
      unsubOpened();
      unsubResolved();
    };
  }, []);

  return {
    trades,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    error,
    refetch: fetchTrades,
  };
}

/**
 * The single live-state hook. The REST snapshot and every WebSocket frame carry
 * the same model, so the stream just replaces state — there is no initial/live
 * split and no merging, hence no visible jump on the handover.
 */
export function useLiveState() {
  const [state, setState] = useState<LiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      setState(await getApiClient().getLiveState());
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const ws = getWsClient();
    ws.connect();
    return ws.on("liveState", (msg: WsMessage) => {
      if (!msg.data) return;
      setState(msg.data as LiveState);
      setLoading(false);
    });
  }, []);

  return { state, loading, error, refetch };
}

export function useActiveMarkets() {
  const [markets, setMarkets] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const dbFetchedRef = useRef(0);

  const PAGE_SIZE = 20;

  const fetchMarkets = useCallback(async () => {
    try {
      setLoading(true);
      dbFetchedRef.current = 0;
      const api = getApiClient();
      const response = await api.getMarkets({
        limit: PAGE_SIZE,
        offset: 0,
      });
      setMarkets(response);
      dbFetchedRef.current = response.length;
      setHasMore(response.length === PAGE_SIZE);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    try {
      setLoadingMore(true);
      const api = getApiClient();
      const response = await api.getMarkets({
        limit: PAGE_SIZE,
        offset: dbFetchedRef.current,
      });
      dbFetchedRef.current += response.length;
      setMarkets((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return [...prev, ...response.filter((m) => !ids.has(m.id))];
      });
      setHasMore(response.length === PAGE_SIZE);
    } catch {
      // keep existing markets on error
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore]);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  return {
    markets,
    loading,
    loadingMore,
    hasMore,
    error,
    refetch: fetchMarkets,
    loadMore,
  };
}

export function usePerformanceRealtime(
  period: "1D" | "1W" | "1M" | "ALL" = "1D",
) {
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getApiClient()
      .getPerformance(period)
      .then((data) => {
        if (!cancelled) {
          setPerformance(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err as Error);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [period]);

  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const unsubOpened = ws.on("tradeOpened", (msg: WsMessage) => {
      const trade = (msg.data as any)?.trade as SimulatedTrade | undefined;
      if (!trade) return;

      setPerformance((prev) => {
        if (!prev) return prev;
        const actualCost = parseFloat(trade.actualCost || "0");
        const oldCash = parseFloat(prev.cashBalance || "0");
        const oldPositionsValue = parseFloat(prev.openPositionsValue || "0");
        return {
          ...prev,
          openPositions: prev.openPositions + 1,
          cashBalance: Math.max(0, oldCash - actualCost).toFixed(2),
          openPositionsValue: (oldPositionsValue + actualCost).toFixed(2),
        };
      });
    });

    const unsubResolved = ws.on("tradeResolved", (msg: WsMessage) => {
      const d = msg.data as any;
      const trade = d?.trade as SimulatedTrade | undefined;
      const isWin = d?.isWin as boolean | undefined;
      const pnl = typeof d?.pnl === "number" ? (d.pnl as number) : 0;

      if (!trade) return;

      setPerformance((prev) => {
        if (!prev) return prev;

        const newWins = prev.wins + (isWin ? 1 : 0);
        const newLosses = prev.losses + (isWin ? 0 : 1);
        const newClosedPositions = newWins + newLosses;

        const oldTotalPnl = parseFloat(prev.totalPnl || "0");
        const newTotalPnl = oldTotalPnl + pnl;

        const actualCost = parseFloat(trade.actualCost || "0");
        const oldCashBalance = parseFloat(prev.cashBalance || "0");
        const newCashBalance = oldCashBalance + actualCost + pnl;

        const oldOpenPositionsValue = parseFloat(
          prev.openPositionsValue || "0",
        );
        const newOpenPositionsValue = Math.max(
          0,
          oldOpenPositionsValue - actualCost,
        );

        const initialCapital = parseFloat(prev.initialCapital || "0");
        const newPortfolioValue = newCashBalance + newOpenPositionsValue;
        const newRoi =
          initialCapital > 0
            ? ((newPortfolioValue - initialCapital) / initialCapital) * 100
            : 0;

        const newWinRate =
          newClosedPositions > 0
            ? ((newWins / newClosedPositions) * 100).toFixed(2)
            : "0.00";

        const oldBestTrade = parseFloat(prev.largestWin || "0");
        const oldWorstTrade = parseFloat(prev.largestLoss || "0");
        const newBestTrade = Math.max(oldBestTrade, Math.max(0, pnl));
        const newWorstTrade = Math.min(oldWorstTrade, Math.min(0, pnl));

        const newOpenPositions = Math.max(0, prev.openPositions - 1);

        return {
          ...prev,
          totalPnl: newTotalPnl.toString(),
          roi: newRoi.toFixed(2),
          wins: newWins,
          losses: newLosses,
          winRate: newWinRate,
          cashBalance: newCashBalance.toFixed(2),
          openPositionsValue: newOpenPositionsValue.toFixed(2),
          largestWin: newBestTrade.toFixed(4),
          largestLoss: newWorstTrade.toFixed(4),
          openPositions: newOpenPositions,
        };
      });
    });

    return () => {
      unsubOpened();
      unsubResolved();
    };
  }, []);

  return { performance, loading, error };
}

export function useUnrealizedPnL(
  trades: SimulatedTrade[],
  liveMarkets: LiveMarketInfo[],
): number {
  return useMemo(() => {
    const openTrades = trades.filter((t) => t.status === "OPEN");
    if (openTrades.length === 0) return 0;
    const priceMap: Record<string, number> = {};
    for (const market of liveMarkets) {
      for (const [tokenId, priceData] of Object.entries(market.prices)) {
        priceMap[tokenId] = priceData.bid;
      }
    }

    let totalUnrealized = 0;
    for (const trade of openTrades) {
      if (!trade.tokenId || !priceMap[trade.tokenId]) continue;

      const entryPrice = parseFloat(trade.entryPrice || "0");
      const currentPrice = priceMap[trade.tokenId];
      const shares = parseFloat(trade.entryShares || "0");

      totalUnrealized += (currentPrice - entryPrice) * shares;
    }

    return totalUnrealized;
  }, [trades, liveMarkets]);
}

export function useAnimatedNumber(
  targetValue: number,
  duration: number = 300,
): number {
  const [displayValue, setDisplayValue] = useState(targetValue);
  const animationRef = useRef<{
    startValue: number;
    startTime: number;
    endValue: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (displayValue === targetValue) {
      return;
    }

    animationRef.current = {
      startValue: displayValue,
      startTime: Date.now(),
      endValue: targetValue,
    };

    const animate = () => {
      if (!animationRef.current) return;

      const elapsed = Date.now() - animationRef.current.startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeProgress = 1 - Math.pow(1 - progress, 3);

      const current =
        animationRef.current.startValue +
        (animationRef.current.endValue - animationRef.current.startValue) *
          easeProgress;

      setDisplayValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(animationRef.current.endValue);
        animationRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [targetValue, duration, displayValue]);

  return displayValue;
}

export function useWsConnection() {
  const [isConnected, setIsConnected] = useState(false);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const resetPongTimeout = () => {
      if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
      pongTimerRef.current = setTimeout(() => setIsConnected(false), 20_000);
    };

    const unsubPong = ws.on("pong", () => {
      setIsConnected(true);
      resetPongTimeout();
    });

    const sendPing = () => ws.sendPing();
    sendPing();
    const pingInterval = setInterval(sendPing, 15_000);

    return () => {
      unsubPong();
      clearInterval(pingInterval);
      if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
    };
  }, []);

  return isConnected;
}

/** Counts down against market time, so it agrees with Polymarket to the second. */
export function useCountdown(endDate: string | null) {
  const calcRemaining = useCallback(() => {
    if (!endDate) return null;
    const diff = new Date(endDate).getTime() - marketNow();
    if (diff <= 0)
      return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
    const totalSeconds = Math.floor(diff / 1000);
    return {
      days: Math.floor(totalSeconds / 86400),
      hours: Math.floor((totalSeconds % 86400) / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
      expired: false,
    };
  }, [endDate]);

  const [remaining, setRemaining] = useState(calcRemaining);

  useEffect(() => {
    const tick = () => setRemaining(calcRemaining());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [calcRemaining]);

  return remaining;
}

export function useSystemStatus() {
  const [backendActive, setBackendActive] = useState(true);
  const wsConnected = useWsConnection();

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const api = getApiClient();
        await api.ping();
        setBackendActive(true);
      } catch {
        setBackendActive(false);
      }
    };

    checkBackend();
  }, []);

  return { backendActive, wsConnected };
}

function auditLogToActivity(log: AuditLog): ActivityEntry {
  const cat = log.category?.toUpperCase() ?? "";
  let kind: ActivityEntry["kind"] = "INFO";
  if (cat.includes("TRADE_RESOLVED") || cat.includes("TRADE_SETTLED"))
    kind = "TRADE_WIN";
  else if (cat.includes("TRADE_OPENED")) kind = "TRADE_OPENED";
  else if (cat.includes("TRADE_FORCE") || cat.includes("LOSS"))
    kind = "TRADE_LOSS";
  else if (cat.includes("MARKET")) kind = "MARKET_RESOLVED";
  else if (log.level === "warn") kind = "WARN";
  else if (log.level === "error") kind = "ERROR";

  if (kind === "TRADE_WIN" && log.metadata) {
    const outcome = (log.metadata as any)?.outcome as string | undefined;
    if (outcome === "LOSS") kind = "TRADE_LOSS";
  }

  const pnl =
    log.metadata && typeof (log.metadata as any).pnl === "number"
      ? (log.metadata as any).pnl
      : undefined;

  return {
    id: log.id,
    kind,
    title: log.category ?? "EVENT",
    detail: log.message,
    ts: new Date(log.createdAt).getTime(),
    pnl,
  };
}

const MAX_ACTIVITY_ENTRIES = 100;

export function useActivityLog() {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const seenIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getApiClient()
      .getAuditLogs({ limit: 30 })
      .then((logs) => {
        if (cancelled) return;
        const entries = logs
          .map(auditLogToActivity)
          .sort((a, b) => b.ts - a.ts);
        entries.forEach((e) => seenIds.current.add(e.id));
        setActivities(entries);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const unsubOpened = ws.on("tradeOpened", (msg: WsMessage) => {
      const trade = (msg.data as any)?.trade as SimulatedTrade | undefined;
      if (!trade) return;
      const id = `opened-${trade.id}`;
      if (seenIds.current.has(id)) return;
      seenIds.current.add(id);

      const outcome = trade.outcomeLabel ?? "??";
      const price = trade.entryPrice
        ? `@${(parseFloat(trade.entryPrice) * 100).toFixed(1)}¢`
        : "";
      const btc = trade.twapAtEntry
        ? ` BTC $${parseFloat(trade.twapAtEntry).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
        : "";
      const zStr = trade.modelEdge
        ? ` edge:${parseFloat(trade.modelEdge).toFixed(3)}`
        : "";

      const entry: ActivityEntry = {
        id,
        kind: "TRADE_OPENED",
        title: "TRADE OPENED",
        detail: `${outcome} ${price}${btc}${zStr} — $${trade.actualCost}`,
        ts: Date.now(),
        trade,
      };

      setActivities((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY_ENTRIES));
    });

    const unsubResolved = ws.on("tradeResolved", (msg: WsMessage) => {
      const d = msg.data as any;
      const trade = d?.trade as SimulatedTrade | undefined;
      const isWin = d?.isWin as boolean | undefined;
      const pnl = typeof d?.pnl === "number" ? (d.pnl as number) : undefined;

      const id = `resolved-${trade?.id ?? Date.now()}`;
      if (seenIds.current.has(id)) return;
      seenIds.current.add(id);

      const kind: ActivityEntry["kind"] = isWin ? "TRADE_WIN" : "TRADE_LOSS";
      const outcome = trade?.outcomeLabel ?? "??";
      const pnlStr = pnl !== undefined ? ` PnL: ${formatPnl(pnl)}` : "";

      const entry: ActivityEntry = {
        id,
        kind,
        title: isWin ? "TRADE WIN ✅" : "TRADE LOSS ❌",
        detail: `${outcome}${pnlStr}`,
        ts: Date.now(),
        trade,
        pnl,
      };

      setActivities((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY_ENTRIES));
    });

    return () => {
      unsubOpened();
      unsubResolved();
    };
  }, []);

  return { activities, loading };
}
