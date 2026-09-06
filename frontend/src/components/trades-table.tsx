"use client";

import type { SimulatedTrade, LiveMarketPrice } from "@/lib/types";
import { marketNow } from "@/lib/market-time";
import { pnlColor } from "@/lib/utils";
import NumberFlow from "@number-flow/react";

interface TradesTableProps {
  trades: SimulatedTrade[];
  loading: boolean;
  livePrices?: Record<string, LiveMarketPrice>;
  marketEndDates?: Record<string, string>;
  onTradeClick?: (trade: SimulatedTrade) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}

export function TradesTable({
  trades,
  loading,
  livePrices = {},
  marketEndDates = {},
  onTradeClick,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: TradesTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-pulse" />
          Loading trades…
        </div>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
        <div className="w-8 h-8 rounded-full border border-border/30 flex items-center justify-center text-muted-foreground/40 text-sm">
          ○
        </div>
        <div className="text-sm text-muted-foreground font-mono">
          No trades yet
        </div>
        <div className="text-xs text-muted-foreground/50 font-mono">
          Waiting for a decided window with a stale ask…
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border/30">
            <th className="text-left py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              WINDOW
            </th>
            <th className="text-left py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              SIDE
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              ENTRY
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              EXIT
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              SHARES
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              P&L
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              STATUS
            </th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade, idx) => {
            const entryPrice = parseFloat(trade.entryPrice);
            const entryCents = Math.round(entryPrice * 100);
            const shares = parseFloat(trade.entryShares || "0");
            const fees = parseFloat(trade.entryFees || "0");
            const actualCost = parseFloat(trade.actualCost || "1");
            const isUp = trade.outcomeLabel === "Up";
            const isClosed = trade.status === "SETTLED";
            const isOpen = trade.status === "OPEN";

            const exitPrice = trade.exitPrice
              ? parseFloat(trade.exitPrice)
              : null;
            const exitCents =
              exitPrice !== null ? Math.round(exitPrice * 100) : null;

            // Oracle hasn't resolved yet but the CLOB WS keeps quoting: track live PnL until settlement
            const livePrice =
              isOpen && trade.tokenId
                ? (livePrices[trade.tokenId] ?? null)
                : null;
            const liveBid = livePrice?.bid ?? null;
            const liveCents =
              liveBid !== null ? Math.round(liveBid * 100) : null;

            const marketEndDate =
              isOpen && trade.marketId && marketEndDates[trade.marketId]
                ? new Date(marketEndDates[trade.marketId]!)
                : null;
            const isPending =
              isOpen &&
              marketEndDate !== null &&
              marketEndDate.getTime() <= marketNow();

            const unrealizedPnl =
              liveBid !== null ? (liveBid - entryPrice) * shares - fees : null;

            const realizedPnl = parseFloat(trade.realizedPnl || "0");
            const hasPnl = isClosed && !!trade.realizedPnl;

            const realizedPnlPct =
              actualCost > 0 ? (realizedPnl / actualCost) * 100 : 0;
            const unrealizedPnlPct =
              unrealizedPnl !== null && actualCost > 0
                ? (unrealizedPnl / actualCost) * 100
                : null;

            const endDate = trade.marketId
              ? (marketEndDates[trade.marketId] ?? null)
              : null;
            const windowInfo = extractTimeWindow(trade, endDate);

            return (
              <tr
                key={trade.id}
                onClick={() => onTradeClick?.(trade)}
                className={`border-b border-border/5 cursor-pointer transition-colors duration-150 hover:bg-muted/15 ${
                  idx % 2 === 0 ? "bg-transparent" : "bg-card/5"
                } ${trade.status === "OPEN" ? "bg-emerald-500/5" : ""}`}
              >
                <td className="py-3 px-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-foreground text-xs">
                      {windowInfo.time}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">
                      {windowInfo.date}
                    </span>
                  </div>
                </td>

                <td className="py-3 px-3">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider ${
                      isUp
                        ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                        : "bg-red-500/10 text-red-500 border border-red-500/20"
                    }`}
                  >
                    <span className="text-[9px]">{isUp ? "▲" : "▼"}</span>
                    {isUp ? "UP" : "DOWN"}
                  </span>
                </td>

                <td className="py-3 px-3 text-right">
                  <span className="text-foreground tabular-nums">
                    {entryCents}¢
                  </span>
                </td>

                <td className="py-3 px-3 text-right">
                  {exitCents !== null ? (
                    <span
                      className={`tabular-nums font-medium ${
                        exitCents >= entryCents
                          ? "text-emerald-500"
                          : "text-red-500"
                      }`}
                    >
                      {exitCents}¢
                    </span>
                  ) : liveCents !== null ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        className={`tabular-nums font-medium ${
                          liveCents >= entryCents
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {liveCents}¢
                      </span>
                      <span
                        className={`text-[9px] font-mono ${
                          isPending ? "text-amber-400" : "text-blue-400"
                        }`}
                      >
                        ● {isPending ? "SETTLING" : "LIVE"}
                      </span>
                    </div>
                  ) : isPending ? (
                    <span className="text-[10px] font-mono text-amber-500/80 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                      PENDING
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>

                <td className="py-3 px-3 text-right tabular-nums text-muted-foreground">
                  <NumberFlow
                    value={shares}
                    format={{
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }}
                  />
                </td>

                <td className="py-3 px-3 text-right">
                  {hasPnl ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        className={`tabular-nums font-semibold ${pnlColor(realizedPnl)}`}
                      >
                        <NumberFlow
                          value={realizedPnl}
                          format={{
                            style: "currency",
                            currency: "USD",
                            signDisplay: "always",
                            minimumFractionDigits: 4,
                            maximumFractionDigits: 4,
                          }}
                        />
                      </span>
                      <span
                        className={`text-[10px] tabular-nums ${pnlColor(realizedPnl, "60")}`}
                      >
                        <NumberFlow
                          value={realizedPnlPct}
                          format={{
                            signDisplay: "always",
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }}
                        />
                        %
                      </span>
                    </div>
                  ) : unrealizedPnl !== null ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        className={`tabular-nums font-semibold ${
                          unrealizedPnl >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        <NumberFlow
                          value={unrealizedPnl}
                          format={{
                            style: "currency",
                            currency: "USD",
                            signDisplay: "always",
                            minimumFractionDigits: 4,
                            maximumFractionDigits: 4,
                          }}
                        />
                      </span>
                      {unrealizedPnlPct !== null && (
                        <span
                          className={`text-[10px] tabular-nums ${
                            unrealizedPnlPct >= 0
                              ? "text-emerald-400/60"
                              : "text-red-400/60"
                          }`}
                        >
                          <NumberFlow
                            value={unrealizedPnlPct}
                            format={{
                              signDisplay: "always",
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }}
                          />
                          %
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>

                <td className="py-3 px-3 text-right">
                  {isClosed ? (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                        trade.exitOutcome === "WIN"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-muted/40 text-muted-foreground"
                      }`}
                    >
                      {trade.exitReason
                        ? `${trade.exitOutcome || "SETTLED"}`
                        : trade.exitOutcome || "SETTLED"}
                    </span>
                  ) : isPending ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
                      PENDING
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-500">
                      <span className="w-1 h-1 rounded-full bg-blue-500 animate-pulse" />
                      OPEN
                    </span>
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

function extractTimeWindow(
  trade: SimulatedTrade,
  marketEndDate: string | null,
): { time: string; date: string } {
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const endDateStr = trade.marketEndDate ?? marketEndDate;

  if (endDateStr) {
    const endDate = new Date(endDateStr);
    return {
      time: fmtTime(endDate),
      date: endDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
    };
  }

  const entryDate = new Date(trade.entryTs);
  return {
    time: fmtTime(entryDate),
    date: entryDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  };
}
