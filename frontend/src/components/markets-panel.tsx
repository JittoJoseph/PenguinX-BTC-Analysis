"use client";

import { useEffect } from "react";
import { marketNow } from "@/lib/market-time";
import type { DiscoveredMarket, SimulatedTrade } from "@/lib/types";
import { MARKET_WINDOW_LABEL } from "@/lib/types";

interface MarketsPanelProps {
  markets: DiscoveredMarket[];
  trades: SimulatedTrade[];
  loading: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  refetch?: () => void;
  onMarketClick: (market: DiscoveredMarket) => void;
}

function polymarketMarketUrl(market: DiscoveredMarket): string {
  if (market.slug) return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/market/${market.id}`;
}

function formatTimeRange(market: DiscoveredMarket): string {
  if (!market.endDate) return "—";

  const endDate = new Date(market.endDate);
  const timeStr = endDate.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${timeStr}`;
}

function getMarketTradeStatus(
  market: DiscoveredMarket,
  trades: SimulatedTrade[],
): { tookTrade: boolean; outcome: "WIN" | "LOSS" | null } {
  const marketTrades = trades.filter((trade) => trade.marketId === market.id);
  if (marketTrades.length === 0) {
    return { tookTrade: false, outcome: null };
  }

  const resolvedTrade = marketTrades.find(
    (trade) => trade.realizedPnl !== null,
  );
  if (resolvedTrade) {
    const pnl = parseFloat(resolvedTrade.realizedPnl || "0");
    return { tookTrade: true, outcome: pnl > 0 ? "WIN" : "LOSS" };
  }

  return { tookTrade: true, outcome: null };
}

function formatTimeAgo(endTime: number): string {
  const now = marketNow();
  const diff = now - endTime;
  if (diff <= 0) return "ACTIVE";

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimeRemaining(endTime: number): string {
  const now = marketNow();
  const diff = endTime - now;
  if (diff <= 0) return "ENDED";

  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function MarketsPanel({
  markets,
  trades,
  loading,
  loadingMore = false,
  hasMore = false,
  onLoadMore,
  refetch,
  onMarketClick,
}: MarketsPanelProps) {
  useEffect(() => {
    if (!refetch || markets.length === 0) return;

    const activeMarket = markets.find(
      (m) => m.computedStatus === "ACTIVE" || m.active,
    );
    if (!activeMarket?.endDate) return;

    const endTime = new Date(activeMarket.endDate).getTime();
    const now = marketNow();
    const timeUntilEnd = endTime - now;

    if (timeUntilEnd > 0) {
      const timer = setTimeout(() => {
        refetch();
      }, timeUntilEnd + 2000);
      return () => clearTimeout(timer);
    }
  }, [markets, refetch]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted-foreground font-mono animate-pulse">
          Loading markets...
        </div>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted-foreground font-mono">
          No active markets discovered.
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border/30 text-muted-foreground">
            <th className="text-left py-2 px-2 font-medium">TIME</th>
            <th className="text-left py-2 px-2 font-medium">DATE</th>
            <th className="text-left py-2 px-2 font-medium">STATUS</th>
            <th className="text-center py-2 px-2 font-medium">TRADE</th>
            <th className="text-right py-2 px-2 font-medium">TIME LEFT</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => {
            const fallbackLabel = MARKET_WINDOW_LABEL;
            const label = market.endDate 
              ? new Date(market.endDate).toLocaleDateString([], { month: "short", day: "numeric" }) 
              : fallbackLabel;
            const href = polymarketMarketUrl(market);

            const status: "ACTIVE" | "ENDED" = market.computedStatus
              ? market.computedStatus
              : market.endDate &&
                  new Date(market.endDate).getTime() > marketNow()
                ? "ACTIVE"
                : "ENDED";

            const isActive = status === "ACTIVE";
            const timeRange = formatTimeRange(market);
            const tradeStatus = getMarketTradeStatus(market, trades);

            return (
              <tr
                key={market.id}
                className={`border-b border-border/10 transition-colors cursor-pointer ${
                  isActive
                    ? "bg-emerald-500/5 hover:bg-emerald-500/10"
                    : "hover:bg-muted/20"
                }`}
                onClick={() => onMarketClick(market)}
                title="View market details"
              >
                <td className="py-2.5 px-2">
                  <span className="text-foreground font-medium tabular-nums">
                    {timeRange}
                  </span>
                </td>
                <td className="py-2.5 px-2">
                  <span className="text-muted-foreground">{label}</span>
                </td>
                <td className="py-2.5 px-2">
                  {isActive ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                      ACTIVE
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                      ENDED
                    </span>
                  )}
                </td>
                <td className="py-2.5 px-2 text-center">
                  {tradeStatus.tookTrade ? (
                    tradeStatus.outcome === "WIN" ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                        WIN
                      </span>
                    ) : tradeStatus.outcome === "LOSS" ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                        LOSS
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        OPEN
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground/50 text-[10px]">
                      —
                    </span>
                  )}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                  {market.endDate ? (
                    isActive ? (
                      <span className="text-emerald-400">
                        {formatTimeRemaining(
                          new Date(market.endDate).getTime(),
                        )}
                      </span>
                    ) : (
                      <span className="text-amber-400">
                        {formatTimeAgo(new Date(market.endDate).getTime())}
                      </span>
                    )
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {(hasMore || loadingMore) && (
        <div className="flex justify-center pt-3 pb-1">
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded text-[11px] font-mono text-muted-foreground border border-border/30 hover:border-border/60 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loadingMore ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-pulse" />
                Loading…
              </>
            ) : (
              "Show more"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
