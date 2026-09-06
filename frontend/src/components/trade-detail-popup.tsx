"use client";

import type { SimulatedTrade } from "@/lib/types";
import { marketNow } from "@/lib/market-time";
import { MARKET_WINDOW_LABEL } from "@/lib/types";
import { pnlColor } from "@/lib/utils";
import { useLiveState } from "@/lib/hooks";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ExternalLink, X } from "lucide-react";

interface TradeDetailPopupProps {
  trade: SimulatedTrade | null;
  open: boolean;
  onClose: () => void;
  marketSlug?: string | null;
  marketQuestion?: string | null;
}

const num = (v: string | null | undefined): number | null =>
  v == null || v === "" ? null : Number.parseFloat(v);

const cents = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(1)}¢`;

const usd = (v: number, digits = 2) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export function TradeDetailPopup({
  trade,
  open,
  onClose,
  marketSlug,
  marketQuestion,
}: TradeDetailPopupProps) {
  const { state } = useLiveState();

  if (!trade) return null;

  const isOpen = trade.status === "OPEN";
  const entryPrice = num(trade.entryPrice) ?? 0;
  const shares = num(trade.entryShares) ?? 0;
  const cost = num(trade.actualCost) ?? 0;
  const fees = num(trade.entryFees) ?? 0;
  const exitPrice = num(trade.exitPrice);

  // Live overlay: while a position is open the backend streams its observables.
  const livePos = state?.openPositions.find((p) => p.tradeId === trade.id);
  const liveBid =
    state?.liveMarkets.find((m) => m.marketId === trade.marketId)?.prices[
      trade.tokenId ?? ""
    ]?.bid ?? null;

  const minPrice = isOpen
    ? (livePos?.minPriceDuringPosition ?? num(trade.minPriceDuringPosition))
    : num(trade.minPriceDuringPosition);

  // Open positions are marked at the executable bid; closed use the booked P&L.
  const pnl = isOpen
    ? liveBid !== null
      ? (liveBid - entryPrice) * shares - fees
      : null
    : (num(trade.realizedPnl) ?? 0);
  const returnPct = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null;

  const outcome = trade.exitOutcome;
  const windowLabel = MARKET_WINDOW_LABEL;

  const polyUrl =
    (marketSlug ?? trade.marketSlug)
      ? `https://polymarket.com/event/${marketSlug ?? trade.marketSlug}`
      : `https://polymarket.com/market/${trade.marketId}`;
  const question = marketQuestion ?? trade.marketQuestion;

  const statusCls = isOpen
    ? "text-blue-400 border-blue-400/25 bg-blue-400/5"
    : outcome === "WIN"
      ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/5"
      : "text-red-400 border-red-500/25 bg-red-500/5";

  const btcAtEntry = num(trade.twapAtEntry);
  const strike = num(trade.strike);
  const distance = num(trade.forecastMarginUsd);
  const decidedFloor = num(trade.decidedFloorUsd);
  const forecastSd = num(trade.forecastSdUsd);
  const enteredAt = num(trade.secondsToEnd);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="w-[calc(100%-2rem)] sm:w-full sm:max-w-[540px] font-mono bg-background border-border/30 flex flex-col max-h-[90dvh] gap-0 p-0 overflow-hidden rounded-xl">
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border/20">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`inline-flex items-center text-[10px] font-semibold tracking-[0.15em] px-2 py-0.5 rounded border ${statusCls}`}
              >
                {isOpen ? "OPEN" : (outcome ?? "SETTLED")}
              </span>
              {trade.outcomeLabel && <Chip>{trade.outcomeLabel}</Chip>}
              {windowLabel && <Chip>{windowLabel}</Chip>}
              {trade.fillStatus && trade.fillStatus !== "FULL" && (
                <Chip>{trade.fillStatus} FILL</Chip>
              )}
              {!isOpen && trade.exitReason && (
                <Chip>{exitReasonLabel(trade.exitReason)}</Chip>
              )}
            </div>

            <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
              {trade.marketId && (
                <a
                  href={polyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] font-mono text-muted-foreground/35 hover:text-blue-400 hover:bg-blue-500/5 transition-colors"
                  aria-label="Open on Polymarket"
                >
                  polymarket <ExternalLink size={10} strokeWidth={1.75} />
                </a>
              )}
              <button
                onClick={onClose}
                className="p-1.5 rounded text-muted-foreground/30 hover:text-foreground hover:bg-muted/40 transition-colors"
                aria-label="Close"
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {question ? (
            <DialogTitle className="mt-2 text-[12px] font-sans font-normal text-foreground/65 leading-relaxed tracking-[0.01em]">
              {question}
            </DialogTitle>
          ) : (
            <DialogTitle className="sr-only">Trade detail</DialogTitle>
          )}
        </div>

        <div
          className={`shrink-0 flex items-center justify-between gap-4 px-4 py-2.5 border-b border-border/20 ${
            pnl === null
              ? ""
              : pnl >= 0
                ? "bg-emerald-500/[0.035]"
                : "bg-red-500/[0.035]"
          }`}
        >
          <div className="flex items-baseline gap-2">
            <Label>{isOpen ? "UNREALIZED P&L" : "P&L"}</Label>
            <span
              className={`text-[15px] font-bold tabular-nums tracking-tight leading-none ${pnl === null ? "text-muted-foreground/40" : pnlColor(pnl)}`}
            >
              {pnl === null
                ? "—"
                : pnl.toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                    signDisplay: "always",
                    minimumFractionDigits: 4,
                    maximumFractionDigits: 4,
                  })}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <Label>RETURN</Label>
            <span
              className={`text-[14px] font-bold tabular-nums leading-none ${returnPct === null ? "text-muted-foreground/40" : pnlColor(returnPct)}`}
            >
              {returnPct === null
                ? "—"
                : `${returnPct.toLocaleString("en-US", {
                    signDisplay: "always",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}%`}
            </span>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 overscroll-contain">
          <Section title="POSITION">
            <Cell label="ENTRY" value={cents(entryPrice)} />
            <Cell
              label={isOpen ? "CURRENT BID" : "EXIT"}
              value={cents(isOpen ? liveBid : exitPrice)}
            />
            <Cell
              label="MIN PRICE"
              hint="Lowest executable bid seen while open"
              value={cents(minPrice)}
            />
            <Cell
              label="STOP PRICE"
              value={cents(livePos?.stopLossPrice ?? null)}
            />
            <Cell label="SHARES" value={shares.toFixed(2)} />
            <Cell label="COST" value={usd(cost, 4)} />
            <Cell label="ENTRY FEES" value={usd(fees, 4)} />
          </Section>

          <Section title="SIGNAL AT ENTRY">
            {btcAtEntry !== null && (
              <Cell label="TWAP" value={usd(btcAtEntry)} />
            )}
            {strike !== null && strike > 0 && (
              <Cell
                label="STRIKE"
                hint="Settlement TWAP at window open — the level the market resolves against"
                value={usd(strike)}
              />
            )}
            {distance !== null && (
              <Cell
                label="FORECAST MARGIN"
                hint="Forecast settlement TWAP minus strike"
                value={
                  <span
                    className={
                      distance >= 0 ? "text-emerald-400" : "text-red-400"
                    }
                  >
                    {distance.toLocaleString("en-US", {
                      style: "currency",
                      currency: "USD",
                      signDisplay: "always",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                }
              />
            )}
            {forecastSd !== null && (
              <Cell
                label="FORECAST σ"
                hint="Standard deviation of the settlement forecast"
                value={`$${forecastSd.toFixed(2)}`}
              />
            )}
            {decidedFloor !== null && (
              <Cell
                label="DECIDED FLOOR"
                hint="Margin the window had to clear to count as decided"
                value={`$${decidedFloor.toFixed(2)}`}
              />
            )}
            {distance !== null && decidedFloor !== null && decidedFloor > 0 && (
              <Cell
                label="MARGIN / FLOOR"
                hint="How far past the decided threshold the entry was"
                value={`${(Math.abs(distance) / decidedFloor).toFixed(1)}×`}
              />
            )}
            {enteredAt !== null && (
              <Cell
                label="ENTERED"
                hint="Time before window close"
                value={`T-${enteredAt.toFixed(0)}s`}
              />
            )}
          </Section>

          <Section title="TIMING">
            <Cell label="OPENED" value={formatTs(trade.entryTs)} />
            <Cell
              label="CLOSED"
              value={trade.exitTs ? formatTs(trade.exitTs) : "—"}
            />
            {trade.marketEndDate && (
              <Cell label="MARKET ENDS" value={formatTs(trade.marketEndDate)} />
            )}
            <Cell
              label="HELD"
              value={formatDuration(trade.entryTs, trade.exitTs)}
            />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-[10px] font-mono font-medium tracking-wider text-muted-foreground/50 border border-border/25 rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground/40 uppercase">
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
      <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y divide-border/[0.08]">
        {children}
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="px-3 py-2 flex flex-col gap-0.5" title={hint}>
      <span className="flex items-center gap-1 text-[10px] font-mono tracking-[0.15em] text-muted-foreground/40 uppercase">
        {label}
      </span>
      <span className="text-[12px] font-mono tabular-nums text-foreground/80 leading-tight">
        {value}
      </span>
    </div>
  );
}

function exitReasonLabel(reason: string): string {
  switch (reason) {
    case "RESOLUTION":
      return "RESOLVED AT CLOSE";
    case "STOP_LOSS":
      return "STOP-LOSS";
    default:
      return reason;
  }
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

/** Elapsed hold; runs to "now" while the position is still open. */
function formatDuration(startIso: string, endIso: string | null): string {
  const ms =
    (endIso ? new Date(endIso).getTime() : marketNow()) -
    new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
