"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { marketNow } from "@/lib/market-time";
import { ExternalLink, X } from "lucide-react";
import type { DiscoveredMarket, SimulatedTrade } from "@/lib/types";
import { MARKET_WINDOW_LABEL } from "@/lib/types";
import NumberFlow from "@number-flow/react";

interface MarketDetailModalProps {
  market: DiscoveredMarket | null;
  trades: SimulatedTrade[];
  open: boolean;
  onClose: () => void;
}

function polymarketMarketUrl(market: DiscoveredMarket): string {
  if (market.slug) return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/market/${market.id}`;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-[10px] font-mono font-medium tracking-wider text-muted-foreground/50 border border-border/25 rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/15 last:border-b-0">
      <div className="px-4 pt-3 pb-1">
        <span className="text-[10px] font-mono font-medium tracking-[0.25em] text-muted-foreground/40 uppercase">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Row2({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border/[0.08]">
      {children}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-2 flex flex-col gap-0.5">
      <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground/40 uppercase">
        {label}
      </span>
      <span className="text-[12px] font-mono tabular-nums text-foreground/80 leading-tight">
        {value}
      </span>
    </div>
  );
}

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatTimeRemaining(endTime: number): string {
  const now = marketNow();
  const diff = endTime - now;
  if (diff <= 0) return "ENDED";

  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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

export function MarketDetailModal({
  market,
  trades,
  open,
  onClose,
}: MarketDetailModalProps) {
  if (!market) return null;

  const isActive = market.computedStatus === "ACTIVE";
  const windowLabel = MARKET_WINDOW_LABEL;
  const polyUrl = polymarketMarketUrl(market);
  const marketTrades = trades.filter((trade) => trade.marketId === market.id);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="w-[calc(100%-2rem)] sm:w-full sm:max-w-[520px] font-mono bg-background border-border/30 max-h-[90dvh] gap-0 p-0 overflow-hidden rounded-xl">
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border/20">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`inline-flex items-center text-[10px] font-semibold tracking-[0.15em] px-2 py-0.5 rounded border ${
                  isActive
                    ? "text-emerald-400 border-emerald-400/25 bg-emerald-400/5"
                    : "text-amber-400 border-amber-400/25 bg-amber-400/5"
                }`}
              >
                {isActive ? "ACTIVE" : "ENDED"}
              </span>
              <Chip>{windowLabel}</Chip>
            </div>
            <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
              <a
                href={polyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] font-mono text-muted-foreground/35 hover:text-blue-400 hover:bg-blue-500/5 transition-colors"
                aria-label="Open on Polymarket"
              >
                polymarket <ExternalLink size={10} strokeWidth={1.75} />
              </a>
              <button
                onClick={onClose}
                className="p-1.5 rounded text-muted-foreground/30 hover:text-foreground hover:bg-muted/40 transition-colors"
                aria-label="Close"
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          <DialogTitle className="mt-2 text-[12px] font-sans font-normal text-foreground/65 leading-relaxed tracking-[0.01em]">
            {market.question}
          </DialogTitle>
        </div>

        <div className="overscroll-contain">
          <Section title="MARKET INFO">
            <Row2>
              <Cell label="ID" value={market.id.slice(0, 16) + "..."} />
              <Cell
                label="CONDITION ID"
                value={market.conditionId?.slice(0, 16) + "..." || "—"}
              />
              <Cell label="CATEGORY" value={market.category} />
              <Cell label="STATUS" value={isActive ? "ACTIVE" : "ENDED"} />
            </Row2>
          </Section>

          <Section title="TIMING">
            <Row2>
              <Cell label="CREATED" value={formatTs(market.createdAt)} />
              <Cell
                label="ENDS"
                value={market.endDate ? formatTs(market.endDate) : "—"}
              />
              <Cell
                label={isActive ? "TIME REMAINING" : "ENDED"}
                value={
                  market.endDate
                    ? isActive
                      ? formatTimeRemaining(new Date(market.endDate).getTime())
                      : formatTimeAgo(new Date(market.endDate).getTime())
                    : "—"
                }
              />
              <Cell
                label="LAST FETCHED"
                value={
                  market.lastFetchedAt ? formatTs(market.lastFetchedAt) : "—"
                }
              />
            </Row2>
          </Section>

          {marketTrades.length > 0 && (
            <Section title="TRADES">
              {marketTrades.map((trade) => (
                <div
                  key={trade.id}
                  className="px-4 py-3 border-b border-border/10 last:border-b-0"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                          trade.outcomeLabel === "Up"
                            ? "text-emerald-400 border-emerald-400/25 bg-emerald-400/5"
                            : "text-red-400 border-red-400/25 bg-red-400/5"
                        }`}
                      >
                        {trade.outcomeLabel || "UNKNOWN"}
                      </span>
                      <span
                        className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                          trade.status === "OPEN"
                            ? "text-blue-400 border-blue-400/25 bg-blue-400/5"
                            : trade.realizedPnl &&
                                parseFloat(trade.realizedPnl) > 0
                              ? "text-emerald-400 border-emerald-400/25 bg-emerald-400/5"
                              : "text-red-400 border-red-400/25 bg-red-400/5"
                        }`}
                      >
                        {trade.status === "OPEN"
                          ? "OPEN"
                          : trade.realizedPnl &&
                              parseFloat(trade.realizedPnl) > 0
                            ? "WIN"
                            : "LOSS"}
                      </span>
                    </div>
                    {trade.realizedPnl && (
                      <span
                        className={`text-[10px] font-mono font-bold tabular-nums ${
                          parseFloat(trade.realizedPnl) >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        <NumberFlow value={parseFloat(trade.realizedPnl)} format={{ style: "currency", currency: "USD", signDisplay: "always", minimumFractionDigits: 4, maximumFractionDigits: 4 }} />
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-[10px] font-mono">
                    <div>
                      <span className="text-muted-foreground/60">ENTRY:</span>
                      <span className="ml-1 tabular-nums">
                        <NumberFlow value={parseFloat(trade.entryPrice)} format={{ style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }} /> ×{" "}
                        <NumberFlow value={parseFloat(trade.entryShares)} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
                      </span>
                    </div>
                    {trade.exitPrice && (
                      <div>
                        <span className="text-muted-foreground/60">EXIT:</span>
                        <span className="ml-1 tabular-nums">
                          <NumberFlow value={parseFloat(trade.exitPrice)} format={{ style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }} />
                        </span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground/60">
                        TWAP @ ENTRY:
                      </span>
                      <span className="ml-1 tabular-nums">
                        $
                        {parseFloat(
                          trade.twapAtEntry || "0",
                        ).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground/60">TIME:</span>
                      <span className="ml-1">{formatTs(trade.entryTs)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </Section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
