import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { FIXED_POSITION_BUDGET_USD, WINDOW_CONFIG } from "../types/index.js";
import { getDb, wipeAndResetPortfolio, getPortfolio } from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, desc, and } from "drizzle-orm";
import { getMarketOrchestrator } from "./market-orchestrator.js";
import { getBtcPriceWatcher } from "./btc-price-watcher.js";
import { getMarketClock, marketNow } from "./market-clock.js";
import {
  calculatePortfolioPerformance,
  type TimePeriod,
} from "./performance-calculator.js";
import { runMonteCarloAnalysis } from "./monte-carlo.js";

const logger = createModuleLogger("api-server");

/** Express API server + WebSocket broadcast for real-time frontend updates. */
export class ApiServer {
  private app: express.Application;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.app = express();
    this.app.use(express.json());
    this.app.use(this.corsMiddleware);
    this.setupRoutes();
  }

  async start(): Promise<void> {
    const config = getConfig();
    this.server = createServer(this.app);

    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      logger.debug("Frontend WS client connected");

      // Hand over the current state at once so the stream never starts empty.
      ws.send(JSON.stringify({ type: "liveState", data: buildLiveState() }));

      // Reply to app-level ping so the frontend can confirm end-to-end connectivity.
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string };
          if (msg.type === "ping") {
            // Market time: the client round-trips this to sync its countdowns.
            ws.send(JSON.stringify({ type: "pong", ts: marketNow() }));
          }
        } catch {
          /* ignore non-JSON frames */
        }
      });

      ws.on("close", () => logger.debug("Frontend WS client disconnected"));
    });

    this.broadcastInterval = setInterval(
      () => this.broadcast({ type: "liveState", data: buildLiveState() }),
      1000,
    );

    const orchestrator = getMarketOrchestrator();
    orchestrator.on("tradeOpened", (data) =>
      this.broadcast({ type: "tradeOpened", data }),
    );
    orchestrator.on("tradeResolved", (data) =>
      this.broadcast({ type: "tradeResolved", data }),
    );

    return new Promise((resolve) => {
      this.server!.listen(config.server.port, config.server.host, () => {
        logger.info(
          { host: config.server.host, port: config.server.port },
          "API server started",
        );
        resolve();
      });
    });
  }

  stop(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getExpressApp(): express.Application {
    return this.app;
  }

  private corsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  }

  /** Reusable admin auth guard — checks Bearer token against config */
  private adminAuth(req: Request, res: Response, next: NextFunction): void {
    const config = getConfig();
    const password = req.headers.authorization?.replace("Bearer ", "");
    if (!password || password !== config.admin.password) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  private setupRoutes(): void {
    this.app.get("/ping", (_req, res) => res.json({ message: "pong" }));
    this.app.get("/health", (_req, res) => {
      const orchestrator = getMarketOrchestrator();
      const stats = orchestrator.getStats();
      res.json({
        status: "ok",
        uptime: process.uptime(),
        ...stats,
      });
    });

    // Same model the WebSocket streams, so the first render is already complete.
    this.app.get(["/api/live-state", "/api/system/stats"], (_req, res) => {
      try {
        res.json(buildLiveState());
      } catch (error) {
        logger.error({ error }, "Live state error");
        res.status(500).json({ error: "Failed to build live state" });
      }
    });

    this.app.get("/api/markets", async (req, res) => {
      try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 200);
        const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

        const markets = await db
          .select({
            id: schema.markets.id,
            conditionId: schema.markets.conditionId,
            slug: schema.markets.slug,
            question: schema.markets.question,
            windowType: schema.markets.windowType,
            category: schema.markets.category,
            endDate: schema.markets.endDate,
            targetPrice: schema.markets.targetPrice,
            active: schema.markets.active,
            outcomes: schema.markets.outcomes,
            clobTokenIds: schema.markets.clobTokenIds,
            lastFetchedAt: schema.markets.lastFetchedAt,
            createdAt: schema.markets.createdAt,
            updatedAt: schema.markets.updatedAt,
            metadata: schema.markets.metadata,
          })
          .from(schema.markets)
          .orderBy(desc(schema.markets.endDate))
          .limit(limit)
          .offset(offset);

        let finalMarkets = [...markets];
        if (offset === 0) {
          const orchestrator = getMarketOrchestrator();
          const rawActive = orchestrator.getRawActiveMarkets();
          const activeFormatted = rawActive.map((m: any) => {
            const tokens = m.tokens || [];
            const clobTokenIds = tokens.map((t: any) => t.token_id);
            let outcomes = [];
            try {
              outcomes = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : [];
            } catch (e) {}
            return {
              id: m.id,
              conditionId: m.conditionId || "",
              slug: m.slug || "",
              question: m.question || "",
              windowType: WINDOW_CONFIG.category,
              category: "Crypto",
              endDate: m.endDate ? new Date(m.endDate).toISOString() : new Date().toISOString(),
              targetPrice: null,
              active: m.active ?? true,
              outcomes,
              clobTokenIds,
              lastFetchedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
              metadata: m,
            };
          });

          const activeIds = new Set(activeFormatted.map(m => m.id));
          const filteredDb = markets.filter(m => !activeIds.has(m.id));
          
          activeFormatted.sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime());
          finalMarkets = [...activeFormatted, ...filteredDb];
        }

        res.json(finalMarkets);
      } catch (error) {
        logger.error({ error }, "Markets list error");
        res.status(500).json({ error: "Failed to get markets" });
      }
    });

    this.app.get("/api/trades", async (req: Request, res: Response) => {
      try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit as string) || 25, 200);
        const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
        const status = req.query.status as string | undefined;

        const conditions = [];
        if (status === "OPEN" || status === "SETTLED") {
          conditions.push(eq(schema.simulatedTrades.status, status));
        }

        const baseQuery = db
          .select({
            trade: schema.simulatedTrades,
            marketEndDate: schema.markets.endDate,
            marketSlug: schema.markets.slug,
            marketQuestion: schema.markets.question,
          })
          .from(schema.simulatedTrades)
          .leftJoin(
            schema.markets,
            eq(schema.simulatedTrades.marketId, schema.markets.id),
          )
          .orderBy(desc(schema.simulatedTrades.entryTs))
          .limit(limit)
          .offset(offset);

        const rows =
          conditions.length > 0
            ? await baseQuery.where(and(...conditions))
            : await baseQuery;

        res.json(
          rows.map((r) => ({
            ...r.trade,
            marketEndDate: r.marketEndDate ?? null,
            marketSlug: r.marketSlug ?? null,
            marketQuestion: r.marketQuestion ?? null,
          })),
        );
      } catch (error) {
        logger.error({ error }, "Trades error");
        res.status(500).json({ error: "Failed to get trades" });
      }
    });

    this.app.get("/api/performance", async (req: Request, res: Response) => {
      try {
        const period = (req.query.period as TimePeriod) || "ALL";
        const validPeriods: TimePeriod[] = ["1D", "1W", "1M", "ALL"];
        if (!validPeriods.includes(period)) {
          res.status(400).json({ error: "Invalid period" });
          return;
        }

        const orchestrator = getMarketOrchestrator();
        const openPositionsValue = orchestrator.computeOpenPositionsValue();
        const metrics = await calculatePortfolioPerformance(
          period,
          undefined,
          openPositionsValue,
        );
        res.json(metrics);
      } catch (error) {
        logger.error({ error }, "Performance error");
        res.status(500).json({ error: "Failed to calculate performance" });
      }
    });

    this.app.get("/api/audit", async (req: Request, res: Response) => {
      try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const rows = await db
          .select()
          .from(schema.auditLogs)
          .orderBy(desc(schema.auditLogs.createdAt))
          .limit(limit);
        res.json(rows);
      } catch (error) {
        res.status(500).json({ error: "Failed to get audit logs" });
      }
    });

    this.app.delete(
      "/api/admin/wipe",
      (req, res, next) => this.adminAuth(req, res, next),
      async (req: Request, res: Response) => {
        try {
          const config = getConfig();
          const orchestrator = getMarketOrchestrator();

          // Order matters. Stop new entries, drop the in-memory session so no
          // orphaned position can settle against the new portfolio, and only
          // then clear the rows.
          orchestrator.pause();
          orchestrator.resetSessionState();

          await wipeAndResetPortfolio(config.portfolio.startingCapital);
          await getDb().delete(schema.markets);
          await orchestrator.portfolioManager.reload();

          logger.warn("Database wiped and portfolio reset via admin endpoint");
          res.json({
            success: true,
            message:
              "All data wiped, portfolio reset. Use POST /api/admin/resume to resume trading.",
          });
        } catch (error) {
          logger.error({ error }, "Wipe error");
          res.status(500).json({ error: "Wipe failed" });
        }
      },
    );

    this.app.post(
      "/api/admin/pause",
      (req, res, next) => this.adminAuth(req, res, next),
      (_req: Request, res: Response) => {
        const orchestrator = getMarketOrchestrator();
        orchestrator.pause();
        res.json({ success: true, paused: true });
      },
    );

    this.app.post(
      "/api/admin/resume",
      (req, res, next) => this.adminAuth(req, res, next),
      async (_req: Request, res: Response) => {
        try {
          const orchestrator = getMarketOrchestrator();
          await orchestrator.resume();
          res.json({ success: true, paused: false });
        } catch (error) {
          logger.error({ error }, "Resume error");
          res.status(500).json({ error: "Resume failed" });
        }
      },
    );

    this.app.get("/api/portfolio", async (_req: Request, res: Response) => {
      try {
        const portfolio = await getPortfolio();
        if (!portfolio) {
          res.status(404).json({ error: "Portfolio not initialised" });
          return;
        }
        const orchestrator = getMarketOrchestrator();
        const openPositionsValue = orchestrator.computeOpenPositionsValue();
        const cashBalance = parseFloat(portfolio.cashBalance);
        const initialCapital = parseFloat(portfolio.initialCapital);
        const portfolioValue = cashBalance + openPositionsValue;

        res.json({
          initialCapital,
          cashBalance,
          openPositionsValue,
          portfolioValue,
          roi:
            initialCapital > 0
              ? ((portfolioValue - initialCapital) / initialCapital) * 100
              : 0,
          createdAt: portfolio.createdAt,
          updatedAt: portfolio.updatedAt,
        });
      } catch (error) {
        logger.error({ error }, "Portfolio error");
        res.status(500).json({ error: "Failed to get portfolio" });
      }
    });

    this.app.get("/api/analysis", async (req: Request, res: Response) => {
      try {
        const simulations = parseInt(req.query.simulations as string) || 10_000;
        const tradesPerSim = parseInt(req.query.tradesPerSim as string) || 100;
        const result = await runMonteCarloAnalysis({
          simulations: Math.min(simulations, 50_000),
          tradesPerSim: Math.min(tradesPerSim, 500),
        });
        res.json(result);
      } catch (error: any) {
        const msg = error?.message || "Analysis failed";
        logger.error({ error }, "Monte Carlo analysis error");
        res
          .status(error?.message?.includes("No settled") ? 400 : 500)
          .json({ error: msg });
      }
    });
  }

  private broadcast(message: unknown): void {
    if (!this.wss) return;
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

}

/**
 * The one live-state model. REST returns it as the initial snapshot and the
 * WebSocket streams the identical shape, so the client never merges two models.
 */
export function buildLiveState() {
  const orchestrator = getMarketOrchestrator();
  const btcWatcher = getBtcPriceWatcher();
  const config = getConfig();
  const pm = orchestrator.portfolioManager;

  return {
    orchestrator: orchestrator.getStats(),
    liveMarkets: orchestrator.getLiveMarkets(),
    openPositions: orchestrator.getOpenPositionSnapshots(),
    btcPrice: btcWatcher.getCurrentTwap(),
    portfolio: {
      cashBalance: pm.getCashBalance(),
      initialCapital: pm.getInitialCapital(),
      openPositionsValue: orchestrator.computeOpenPositionsValue(),
    },
    config: {
      marketWindow: WINDOW_CONFIG.label,
      twapLookbackSeconds: WINDOW_CONFIG.twapLookbackSeconds,
      minEntryPrice: config.strategy.minEntryPrice,
      maxEntryPrice: config.strategy.maxEntryPrice,
      entryWindowOpenSeconds: config.strategy.entryWindowOpenSeconds,
      entryWindowCloseSeconds: config.strategy.entryWindowCloseSeconds,
      sigmaWindowMs: config.strategy.sigmaWindowMs,
      decidedFloorMultiplier: config.strategy.decidedFloorMultiplier,
      decidedSdMultiple: config.strategy.decidedSdMultiple,
      stopLossFraction: config.strategy.stopLossFraction,
      startingCapital: config.portfolio.startingCapital,
      positionBudgetUsd: FIXED_POSITION_BUDGET_USD,
    },
    clock: getMarketClock().getStatus(),
    /** Market time. Clients derive their countdowns from this, never their own clock. */
    timestamp: marketNow(),
  };
}

export type LiveState = ReturnType<typeof buildLiveState>;

let instance: ApiServer | null = null;
export function getApiServer(): ApiServer {
  if (!instance) instance = new ApiServer();
  return instance;
}
