"use client";

import { useState, useEffect, useMemo } from "react";
import { Header } from "./header";
import { SystemStatusIndicator } from "./system-status-indicator";
import { TradesTable } from "./trades-table";
import { TradeDetailPopup } from "./trade-detail-popup";
import { MarketsPanel } from "./markets-panel";
import { ActivityPanel } from "./activity-panel";
import { MarketDetailModal } from "./market-detail-modal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink } from "lucide-react";
import { pnlColor } from "@/lib/utils";
import {
  useTrades,
  useLiveState,
  useActiveMarkets,
  useWsConnection,
  useCountdown,
  usePerformanceRealtime,
  useActivityLog,
  useUnrealizedPnL,
} from "@/lib/hooks";
import type {
  SimulatedTrade,
  DiscoveredMarket,
  LiveState,
  LiveMarketInfo,
  LiveMarketPrice,
} from "@/lib/types";
import {
  MARKET_WINDOW_LABEL,
  MARKET_WINDOW_DURATION_MS,
} from "@/lib/types";
import NumberFlow from "@number-flow/react";

export function DashboardPage() {
  const [activeTab, setActiveTab] = useState("trades");
  const [selectedTrade, setSelectedTrade] = useState<SimulatedTrade | null>(
    null,
  );
  const [selectedMarket, setSelectedMarket] = useState<DiscoveredMarket | null>(
    null,
  );
  const {
    trades,
    loading: tradesLoading,
    loadMore,
    hasMore,
    loadingMore,
  } = useTrades();
  const { state: stats, loading: statsLoading } = useLiveState();
  const {
    markets,
    loading: marketsLoading,
    loadingMore: marketsLoadingMore,
    hasMore: marketsHasMore,
    refetch: refetchMarkets,
    loadMore: loadMoreMarkets,
  } = useActiveMarkets();
  const { activities, loading: activitiesLoading } = useActivityLog();
  useWsConnection();

  // Stable identity: downstream memos key off this list.
  const liveMarkets = useMemo(
    () => stats?.liveMarkets ?? [],
    [stats?.liveMarkets],
  );
  const btcPrice = stats?.btcPrice ?? null;
  const rawSigma = stats?.orchestrator.rawSigma ?? null;

  const primaryMarket = useMemo(() => {
    const byEnd = (a: { endDate: string }, b: { endDate: string }) =>
      new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    const active = liveMarkets.filter((m) => m.status === "ACTIVE").sort(byEnd);
    if (active.length > 0) return active[0]!;
    const upcoming = liveMarkets
      .filter((m) => m.status === "UPCOMING")
      .sort(byEnd);
    return upcoming[0] ?? liveMarkets[0] ?? null;
  }, [liveMarkets]);

  const positionMarkets = useMemo(
    () => liveMarkets.filter((m) => m.status === "ENDED" && m.hasPosition),
    [liveMarkets],
  );

  const livePricesMap = useMemo<Record<string, LiveMarketPrice>>(() => {
    const map: Record<string, LiveMarketPrice> = {};
    for (const m of liveMarkets) {
      for (const [tokenId, price] of Object.entries(m.prices)) {
        map[tokenId] = price;
      }
    }
    return map;
  }, [liveMarkets]);

  // Fallback when btcPriceAtWindowStart is null: entry price of an open trade in this market
  const btcPriceAtWindowStartFallback = useMemo(() => {
    const marketId = primaryMarket?.marketId;
    if (!marketId) return null;
    const trade = trades.find(
      (t) =>
        t.marketId === marketId && t.status === "OPEN" && !!t.twapAtEntry,
    );
    return trade?.twapAtEntry ? parseFloat(trade.twapAtEntry) : null;
  }, [primaryMarket, trades]);

  const marketEndDates = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const m of liveMarkets) map[m.marketId] = m.endDate;
    for (const m of markets) if (m.id && m.endDate) map[m.id] = m.endDate;
    return map;
  }, [liveMarkets, markets]);

  const { slug: selectedTradeSlug, question: selectedTradeQuestion } =
    useMemo(() => {
      if (!selectedTrade) return { slug: null, question: null };
      const live = liveMarkets.find(
        (m) => m.marketId === selectedTrade.marketId,
      );
      const disc = markets.find((m) => m.id === selectedTrade.marketId);
      return {
        slug: live?.slug ?? disc?.slug ?? null,
        question: live?.question ?? disc?.question ?? null,
      };
    }, [selectedTrade, liveMarkets, markets]);

  const windowLabel = MARKET_WINDOW_LABEL;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Header />

      <main className="flex-1 px-4 py-4 pb-16 max-w-7xl mx-auto w-full space-y-4">
        <TopDashboardSection
          stats={stats}
          btcPrice={btcPrice}
          primaryMarket={primaryMarket}
          positionMarkets={positionMarkets}
          activeMarketsCount={
            liveMarkets.filter(
              (m) => m.status === "ACTIVE" || m.status === "UPCOMING",
            ).length
          }
          windowLabel={windowLabel}
          refetchMarkets={refetchMarkets}
          btcPriceAtWindowStartFallback={btcPriceAtWindowStartFallback}
          trades={trades}
          liveMarkets={liveMarkets}
        />

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          <div className="border border-border/30 rounded-lg bg-card/30 overflow-hidden">
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="w-full"
            >
              <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
                <TabsList className="bg-transparent gap-2 h-auto p-0">
                  <TabsTrigger
                    value="trades"
                    className="data-[state=active]:bg-muted/40 rounded px-3 py-1 text-xs font-mono"
                  >
                    TRADES ({trades.length})
                  </TabsTrigger>
                  <TabsTrigger
                    value="markets"
                    className="data-[state=active]:bg-muted/40 rounded px-3 py-1 text-xs font-mono"
                  >
                    MARKETS ({markets.length})
                  </TabsTrigger>
                  <TabsTrigger
                    value="activity"
                    className="data-[state=active]:bg-muted/40 rounded px-3 py-1 text-xs font-mono relative"
                  >
                    ACTIVITY
                    {activities.length > 0 && (
                      <span className="ml-1.5 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded text-[9px] font-mono px-1 py-0.5">
                        {activities.length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="trades" className="mt-0">
                <TradesTable
                  trades={trades}
                  loading={tradesLoading}
                  livePrices={livePricesMap}
                  marketEndDates={marketEndDates}
                  onTradeClick={setSelectedTrade}
                  onLoadMore={loadMore}
                  hasMore={hasMore}
                  loadingMore={loadingMore}
                />
              </TabsContent>

              <TabsContent value="markets" className="mt-0">
                <MarketsPanel
                  markets={markets}
                  trades={trades}
                  loading={marketsLoading}
                  loadingMore={marketsLoadingMore}
                  hasMore={marketsHasMore}
                  onLoadMore={loadMoreMarkets}
                  refetch={refetchMarkets}
                  onMarketClick={setSelectedMarket}
                />
              </TabsContent>

              <TabsContent value="activity" className="mt-0">
                <ActivityPanel
                  activities={activities}
                  loading={activitiesLoading}
                />
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-4">
            <SidebarCard title="SYSTEM">
              {statsLoading ? (
                <div className="text-xs text-muted-foreground animate-pulse font-mono py-4 text-center">
                  Loading...
                </div>
              ) : stats ? (
                <div className="space-y-2 text-xs font-mono">
                  <StatRow label="Window Type" value={windowLabel} />
                  <StatRow
                    label="Open Positions"
                    value={stats.orchestrator.openPositions.toString()}
                  />
                  <StatRow
                    label="Active Markets"
                    value={stats.orchestrator.activeMarkets.toString()}
                  />
                  <StatRow
                    label="Trades Exec"
                    value={stats.orchestrator.cycleCount.toString()}
                  />
                  <StatRow
                    label="Discovered"
                    value={stats.orchestrator.scanner.discoveredCount.toString()}
                  />
                  <StatRow
                    label="Engine"
                    value={
                      stats.orchestrator.paused
                        ? "PAUSED"
                        : stats.orchestrator.running
                          ? "ACTIVE"
                          : "IDLE"
                    }
                    accent={
                      stats.orchestrator.running && !stats.orchestrator.paused
                    }
                    warn={stats.orchestrator.paused}
                  />
                  <StatRow
                    label="CLOB WS"
                    value={
                      stats.orchestrator.ws.connected
                        ? "CONNECTED"
                        : "DISCONNECTED"
                    }
                    accent={stats.orchestrator.ws.connected}
                  />
                  <StatRow
                    label="BTC Feed"
                    value={stats.orchestrator.btcConnected ? "LIVE" : "OFFLINE"}
                    accent={stats.orchestrator.btcConnected}
                  />
                  <StatRow
                    label="BTC Vol"
                    value={(() => {
                      const s = rawSigma ?? stats.orchestrator.rawSigma;
                      return s != null ? `~$${s.toFixed(2)}/s` : "—";
                    })()}
                  />
                </div>
              ) : null}
            </SidebarCard>

            <SidebarCard title="CONFIGURATION">
              {stats?.config ? (
                <div className="space-y-2 text-xs font-mono">
                  <StatRow
                    label="TWAP Lookback"
                    value={`${stats.config.twapLookbackSeconds}s`}
                  />
                  <StatRow
                    label="Entry Band"
                    value={`${stats.config.minEntryPrice.toFixed(2)}–${stats.config.maxEntryPrice.toFixed(2)}`}
                  />
                  <StatRow
                    label="Entry Window"
                    value={`${stats.config.entryWindowCloseSeconds}–${stats.config.entryWindowOpenSeconds}s`}
                  />
                  <StatRow
                    label="Sigma Window"
                    value={`${Math.round(stats.config.sigmaWindowMs / 1000)}s`}
                  />
                  <StatRow
                    label="Decided Floor ×"
                    value={stats.config.decidedFloorMultiplier.toString()}
                  />
                  <StatRow
                    label="Decided SD Multiple"
                    value={stats.config.decidedSdMultiple.toString()}
                  />
                  <StatRow
                    label="Market Liveness"
                    value={`fill within ${Math.round(stats.config.marketLivenessMs / 1000)}s`}
                  />
                  <StatRow
                    label="Stop Loss"
                    value={`${(stats.config.stopLossFraction * 100).toFixed(0)}% below entry`}
                    accent
                  />
                  <StatRow
                    label="Position Budget"
                    value={`$${stats.config.positionBudgetUsd} fixed`}
                  />
                  <StatRow
                    label="Starting Capital"
                    value={`$${stats.config.startingCapital}`}
                  />
                </div>
              ) : (
                <div className="text-xs text-muted-foreground font-mono py-4 text-center">
                  Loading...
                </div>
              )}
            </SidebarCard>
          </div>
        </div>
      </main>

      <SystemStatusIndicator stats={stats} />

      <TradeDetailPopup
        trade={selectedTrade}
        open={selectedTrade !== null}
        onClose={() => setSelectedTrade(null)}
        marketSlug={selectedTradeSlug}
        marketQuestion={selectedTradeQuestion}
      />

      <MarketDetailModal
        market={selectedMarket}
        trades={trades}
        open={selectedMarket !== null}
        onClose={() => setSelectedMarket(null)}
      />
    </div>
  );
}

function polymarketUrl(market: LiveMarketInfo): string {
  if (market.slug) return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/market/${market.marketId}`;
}

function TopDashboardSection({
  stats,
  btcPrice,
  primaryMarket,
  positionMarkets,
  activeMarketsCount,
  windowLabel,
  refetchMarkets,
  btcPriceAtWindowStartFallback,
  trades,
  liveMarkets,
}: {
  stats: LiveState | null;
  btcPrice: { price: number; timestamp: number } | null;
  primaryMarket: LiveMarketInfo | null;
  positionMarkets: LiveMarketInfo[];
  activeMarketsCount: number;
  windowLabel: string;
  refetchMarkets: () => void;
  btcPriceAtWindowStartFallback: number | null;
  trades: SimulatedTrade[];
  liveMarkets: LiveMarketInfo[];
}) {
  const [period, setPeriod] = useState<"1D" | "1W" | "1M" | "ALL">("ALL");
  const { performance } = usePerformanceRealtime(period);

  const liveUnrealizedPnL = useUnrealizedPnL(trades, liveMarkets);

  const isPaused = stats?.orchestrator.paused ?? false;

  const countdown = useCountdown(primaryMarket?.endDate ?? null);

  useEffect(() => {
    if (countdown?.expired) {
      const timer = setTimeout(() => refetchMarkets(), 2000);
      return () => clearTimeout(timer);
    }
  }, [countdown?.expired, refetchMarkets]);

  const upPrice = primaryMarket
    ? (primaryMarket.prices[primaryMarket.yesTokenId]?.ask ?? null)
    : null;
  const downPrice = primaryMarket
    ? (primaryMarket.prices[primaryMarket.noTokenId]?.ask ?? null)
    : null;

  const fmtPct = (v: number | null) =>
    v !== null ? `${(v * 100).toFixed(1)}¢` : "—";

  const fmtCountdown = () => {
    if (!countdown) return "—";
    if (countdown.expired) return "00:00";
    const { days, hours, minutes, seconds } = countdown;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0)
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };

  const roi = parseFloat(performance?.roi || "0");
  const winRate = parseFloat(performance?.winRate || "0");
  const totalDeployed = parseFloat(performance?.totalDeployed || "0");
  const cashBalance = parseFloat(performance?.cashBalance || "0");
  const initialCapital = parseFloat(performance?.initialCapital || "0");
  const openPositionsValue = parseFloat(performance?.openPositionsValue || "0");
  const portfolioValue = cashBalance + openPositionsValue;
  const unrealizedPnl = liveUnrealizedPnL;
  const wins = performance?.wins || 0;
  const losses = performance?.losses || 0;
  const closedPositions = wins + losses;
  const openPositions = performance?.openPositions || 0;
  const bestTrade = parseFloat(performance?.largestWin || "0");
  const worstTrade = parseFloat(performance?.largestLoss || "0");
  const avgWin = parseFloat(performance?.avgWin || "0");
  const avgLoss = parseFloat(performance?.avgLoss || "0");
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  const gainFromInitial = portfolioValue - initialCapital;
  const mainDisplayValue = gainFromInitial;

  const effectiveBtcAtStart =
    primaryMarket?.btcPriceAtWindowStart ??
    btcPriceAtWindowStartFallback ??
    null;

  const marketDetails = useMemo(() => {
    if (!primaryMarket) return null;
    const question = primaryMarket.question;

    // Absolute "above/below $X" markets carry the target in the question; Up/Down markets use btcPriceAtWindowStart
    const absolutePriceMatch = question.match(
      /(?:above|below)\s*\$([0-9,]+(?:\.\d+)?)/i,
    );
    const targetPriceStr = absolutePriceMatch
      ? `$${absolutePriceMatch[1]}`
      : effectiveBtcAtStart !== null
        ? `$${effectiveBtcAtStart.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : null;
    const targetPriceNum = absolutePriceMatch
      ? parseFloat(absolutePriceMatch[1].replace(/,/g, ""))
      : effectiveBtcAtStart;

    const end = new Date(primaryMarket.endDate);
    const windowDurationMs = MARKET_WINDOW_DURATION_MS;
    const mins = Math.floor(windowDurationMs / 60000);
    const start = new Date(end.getTime() - windowDurationMs);
    const fmt = (d: Date) =>
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const qLower = question.toLowerCase();
    const isAbove =
      qLower.includes("above") ||
      qLower.includes("higher") ||
      qLower.includes("over");
    const isBelow =
      qLower.includes("below") ||
      qLower.includes("lower") ||
      qLower.includes("under");

    return {
      targetPriceStr,
      targetPriceNum,
      startTime: fmt(start),
      endTime: fmt(end),
      windowLabel:
        mins >= 60
          ? mins >= 1440
            ? "1D window"
            : `${mins / 60}H window`
          : `${mins}M window`,
      direction: isAbove ? "above" : isBelow ? "below" : null,
    };
  }, [primaryMarket, effectiveBtcAtStart]);

  const btcDistanceInfo = useMemo(() => {
    if (!marketDetails?.targetPriceNum || !btcPrice) return null;
    const dist = btcPrice.price - marketDetails.targetPriceNum;
    return {
      dist: Math.abs(dist),
      above: dist >= 0,
    };
  }, [marketDetails, btcPrice]);

  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  return (
    <div className="border border-border/30 rounded-xl bg-background overflow-hidden">
      {isPaused && (
        <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-red-500/10 border-b border-red-500/20">
          <span className="text-[11px] font-mono font-bold text-red-400 tracking-widest">
            SYSTEM PAUSED — Use Resume to restart trading
          </span>
        </div>
      )}

      <div className="flex flex-col xl:flex-row divide-y xl:divide-y-0 xl:divide-x divide-border/30">
        <div className="xl:w-[420px] xl:shrink-0 p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className={`w-1.5 h-1.5 rounded-full ${
                  primaryMarket?.status === "ACTIVE"
                    ? "bg-emerald-500 animate-pulse"
                    : primaryMarket?.status === "UPCOMING"
                      ? "bg-amber-500/70"
                      : "bg-muted-foreground/30"
                }`}
              />
              <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground">
                {primaryMarket?.status === "UPCOMING"
                  ? "UPCOMING MARKET"
                  : "ACTIVE MARKET"}
              </span>
            </div>
            {primaryMarket && (
              <a
                href={polymarketUrl(primaryMarket)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-mono text-muted-foreground/50 hover:text-blue-400 flex items-center gap-1 transition-colors"
              >
                polymarket <ExternalLink size={9} />
              </a>
            )}
          </div>

          {primaryMarket ? (
            <>
              <p className="text-sm font-mono text-foreground/80 leading-relaxed">
                {primaryMarket.question}
              </p>

              <div className="flex flex-wrap gap-1.5">
                {marketDetails?.windowLabel && (
                  <span className="text-[10px] font-mono text-muted-foreground border border-border/30 rounded px-2 py-0.5">
                    {marketDetails.windowLabel}
                  </span>
                )}
                {marketDetails?.startTime && (
                  <span className="text-[10px] font-mono text-muted-foreground border border-border/30 rounded px-2 py-0.5">
                    {marketDetails.startTime} → {marketDetails.endTime}
                  </span>
                )}
                {marketDetails?.direction && (
                  <span
                    className={`text-[10px] font-mono border rounded px-2 py-0.5 ${marketDetails.direction === "above" ? "text-emerald-500 border-emerald-500/30" : "text-red-500 border-red-500/30"}`}
                  >
                    {marketDetails.direction}
                  </span>
                )}
              </div>

              <div className="border border-border/30 rounded-lg overflow-hidden">
                <div className="grid grid-cols-2 divide-x divide-border/30">
                  <div className="p-3">
                    <div className="text-[10px] font-mono text-muted-foreground mb-1 tracking-widest">
                      {effectiveBtcAtStart !== null
                        ? "BTC AT START"
                        : "PRICE TO BEAT"}
                    </div>
                    <div className="text-base font-bold font-mono tabular-nums text-foreground">
                      {marketDetails?.targetPriceStr ?? "—"}
                    </div>
                    {effectiveBtcAtStart !== null && (
                      <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                        window open price
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <div
                        className={`w-1 h-1 rounded-full ${btcPrice ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/30"}`}
                      />
                      <span className="text-[10px] font-mono text-muted-foreground tracking-widest">
                        BTC NOW
                      </span>
                    </div>
                    <div className="text-base font-bold font-mono tabular-nums text-foreground">
                      {btcPrice ? `$${fmtUsd(btcPrice.price)}` : "—"}
                    </div>
                  </div>
                </div>
                {btcDistanceInfo && (
                  <div className="border-t border-border/30 px-3 py-1.5 flex items-center gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground">
                      DISTANCE
                    </span>
                    <span
                      className={`text-[10px] font-mono font-bold tabular-nums ${btcDistanceInfo.above ? "text-emerald-500" : "text-red-500"}`}
                    >
                      {btcDistanceInfo.above ? "+" : "-"}$
                      {fmtUsd(btcDistanceInfo.dist)}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/50 ml-auto">
                      BTC is {btcDistanceInfo.above ? "above" : "below"} target
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-1 border border-border/30 rounded-lg p-3 flex flex-col items-center justify-center text-center gap-0.5">
                  <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                    {countdown?.expired ? "ENDED" : "CLOSES IN"}
                  </div>
                  <div
                    className={`text-lg font-bold font-mono tabular-nums tracking-tight leading-none ${
                      countdown?.expired
                        ? "text-amber-400"
                        : countdown &&
                            countdown.hours === 0 &&
                            countdown.minutes < 1
                          ? "text-red-400 animate-pulse"
                          : "text-foreground"
                    }`}
                  >
                    {fmtCountdown()}
                  </div>
                  {marketDetails?.endTime && (
                    <div className="text-[10px] font-mono text-muted-foreground/40 tabular-nums">
                      {marketDetails.endTime}
                    </div>
                  )}
                </div>
                <div className="border border-emerald-500/20 bg-emerald-500/5 rounded-lg p-3 flex flex-col items-center justify-center text-center">
                  <div className="text-[10px] font-mono text-emerald-500/60 mb-1">
                    UP ▲
                  </div>
                  <div className="text-base font-bold font-mono tabular-nums text-emerald-400">
                    {fmtPct(upPrice)}
                  </div>
                </div>
                <div className="border border-red-500/20 bg-red-500/5 rounded-lg p-3 flex flex-col items-center justify-center text-center">
                  <div className="text-[10px] font-mono text-red-500/60 mb-1">
                    DOWN ▼
                  </div>
                  <div className="text-base font-bold font-mono tabular-nums text-red-400">
                    {fmtPct(downPrice)}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs font-mono text-muted-foreground/40 py-8">
              Waiting for active market…
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground">
                PORTFOLIO PERFORMANCE
              </span>
              <span className="text-[10px] font-mono text-muted-foreground/40">
                [{period}]
              </span>
            </div>
            <div className="flex border border-border/20 rounded overflow-hidden">
              {(["1D", "1W", "1M", "ALL"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`text-[10px] font-mono px-2.5 py-1 transition-colors ${period === p ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border/20">
            <div className="p-5 space-y-4">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-1">
                  NET P&L
                </div>
                <div
                  className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${pnlColor(mainDisplayValue)}`}
                >
                  <NumberFlow
                    value={mainDisplayValue}
                    format={{
                      style: "currency",
                      currency: "USD",
                      signDisplay: "always",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }}
                  />
                </div>
                <div
                  className={`text-xs font-mono mt-1 ${pnlColor(roi, "70")}`}
                >
                  <NumberFlow
                    value={roi}
                    format={{
                      signDisplay: "always",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }}
                  />
                  % ROI
                </div>
              </div>
              <div className="space-y-3 pt-1">
                <div>
                  <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
                    UNREALIZED
                  </div>
                  <div
                    className={`text-sm font-bold font-mono tabular-nums ${pnlColor(unrealizedPnl)}`}
                  >
                    <NumberFlow
                      value={unrealizedPnl}
                      format={{
                        style: "currency",
                        currency: "USD",
                        signDisplay: "always",
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
                    INITIAL CAPITAL
                  </div>
                  <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                    <NumberFlow
                      value={initialCapital}
                      format={{
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
                    CURRENT VALUE
                  </div>
                  <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                    <NumberFlow
                      value={portfolioValue}
                      format={{
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
                  PORTFOLIO VALUE
                </div>
                <div className="text-2xl font-bold font-mono tabular-nums text-foreground">
                  <NumberFlow
                    value={portfolioValue}
                    format={{
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }}
                  />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5 flex items-center gap-1">
                  cash{" "}
                  <NumberFlow
                    value={cashBalance}
                    format={{
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }}
                  />{" "}
                  + positions{" "}
                  <NumberFlow
                    value={openPositionsValue}
                    format={{
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }}
                  />
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                  TRADE STATISTICS
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    WIN RATE
                  </span>
                  <span className="text-base font-bold font-mono tabular-nums text-foreground flex items-center">
                    <NumberFlow
                      value={winRate}
                      format={{
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }}
                    />
                    %
                  </span>
                </div>
                <div className="h-1 w-full rounded-full overflow-hidden flex bg-red-500/20">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${winRate}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-red-500/70">{losses} losses</span>
                  <span className="text-emerald-500/70">{wins} wins</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 pt-1">
                {[
                  ["OPEN", openPositions],
                  ["SETTLED", closedPositions],
                  ["TOTAL", openPositions + closedPositions],
                ].map(([label, val]) => (
                  <div key={label as string}>
                    <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                      {label}
                    </div>
                    <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                      {val}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                PERFORMANCE
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  BEST TRADE
                </div>
                <div className="text-lg font-bold font-mono tabular-nums text-emerald-500">
                  <NumberFlow
                    value={bestTrade}
                    format={{
                      style: "currency",
                      currency: "USD",
                      signDisplay: "always",
                      minimumFractionDigits: 4,
                      maximumFractionDigits: 4,
                    }}
                  />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5 flex items-center gap-1">
                  avg win:{" "}
                  <NumberFlow
                    value={avgWin}
                    format={{
                      style: "currency",
                      currency: "USD",
                      signDisplay: "always",
                      minimumFractionDigits: 4,
                      maximumFractionDigits: 4,
                    }}
                  />
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  WORST TRADE
                </div>
                <div className="text-lg font-bold font-mono tabular-nums text-red-500">
                  <NumberFlow
                    value={worstTrade}
                    format={{
                      style: "currency",
                      currency: "USD",
                      signDisplay: "always",
                      minimumFractionDigits: 4,
                      maximumFractionDigits: 4,
                    }}
                  />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5 flex items-center gap-1">
                  avg loss:{" "}
                  <NumberFlow
                    value={avgLoss}
                    format={{
                      style: "currency",
                      currency: "USD",
                      signDisplay: "always",
                      minimumFractionDigits: 4,
                      maximumFractionDigits: 4,
                    }}
                  />
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  PROFIT FACTOR
                </div>
                <div className="text-lg font-bold font-mono tabular-nums text-foreground">
                  <NumberFlow
                    value={profitFactor}
                    format={{
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }}
                  />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                  avg win ÷ avg loss
                </div>
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                SYSTEM
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  ENGINE
                </div>
                <div
                  className={`text-sm font-bold font-mono ${isPaused ? "text-red-500" : stats?.orchestrator.running ? "text-emerald-500" : "text-red-500"}`}
                >
                  {isPaused
                    ? "PAUSED"
                    : stats?.orchestrator.running
                      ? "RUNNING"
                      : "STOPPED"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  OPEN POSITIONS
                </div>
                <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                  {stats?.orchestrator.openPositions ?? 0}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  ACTIVE MARKETS
                </div>
                <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                  {activeMarketsCount}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  WINDOW
                </div>
                <div className="text-sm font-bold font-mono text-foreground">
                  {windowLabel}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {positionMarkets.length > 0 && (
        <div className="border-t border-border/20 bg-card/20">
          <div className="px-5 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 animate-pulse" />
                <span className="text-[10px] font-mono text-muted-foreground tracking-[0.15em]">
                  AWAITING RESOLUTION
                </span>
                <span className="text-[10px] font-mono text-muted-foreground/60">
                  ({positionMarkets.length})
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 justify-end">
                {positionMarkets.map((m) => {
                  const end = new Date(m.endDate);
                  const start = m.windowStart ? new Date(m.windowStart) : null;
                  const datePart = end.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  });
                  const timeFmt = (d: Date) =>
                    d.toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    });
                  const label = start
                    ? `${datePart} · ${timeFmt(start).replace(/ AM| PM/, "")}–${timeFmt(end)}`
                    : `${datePart} · ${timeFmt(end)}`;
                  return (
                    <span
                      key={m.marketId}
                      title={m.question ?? undefined}
                      className="text-[10px] font-mono text-muted-foreground bg-muted/30 border border-border/40 rounded-md px-2.5 py-1 whitespace-nowrap hover:bg-muted/50 transition-colors cursor-help"
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border/30 rounded-lg bg-card/30 p-3">
      <div className="text-[10px] text-muted-foreground tracking-widest mb-2 border-b border-border/20 pb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

function StatRow({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          warn
            ? "text-red-400"
            : accent
              ? "text-emerald-500"
              : "text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}
