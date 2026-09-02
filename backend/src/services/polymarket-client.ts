import axios, { AxiosInstance, AxiosError } from "axios";
import { createModuleLogger } from "../utils/logger.js";
import { withRetry, isRateLimitError } from "../utils/retry.js";
import {
  POLY_URLS,
  GammaMarketSchema,
  type GammaMarket,
} from "../types/index.js";
import { z } from "zod";
import { logAudit } from "../db/client.js";

const logger = createModuleLogger("polymarket-client");

export class PolymarketClient {
  private gammaApi: AxiosInstance;

  constructor() {
    this.gammaApi = axios.create({
      baseURL: POLY_URLS.GAMMA_API_BASE,
      timeout: 30000,
      headers: { Accept: "application/json", "User-Agent": "PenguinX/3.0" },
    });

    this.gammaApi.interceptors.response.use(
      (r) => r,
      async (error: AxiosError) => {
        if (error.response?.status === 429) {
          logger.warn({ url: error.config?.url }, "Rate limited (429)");
          await logAudit("warn", "rate_limit", "Rate limited on gammaApi", {
            url: error.config?.url,
            retryAfter: error.response.headers["retry-after"],
          });
        }
        throw error;
      },
    );
  }

  /** Fetch markets from Gamma /markets. `slug` may be an array for multi-lookup. */
  async getMarkets(
    options: {
      slug?: string[];
      active?: boolean;
      closed?: boolean;
      end_date_min?: string;
      end_date_max?: string;
      order?: string;
      ascending?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<GammaMarket[]> {
    return withRetry(
      async () => {
        const params = new URLSearchParams();
        if (options.limit !== undefined)
          params.append("limit", options.limit.toString());
        if (options.offset !== undefined)
          params.append("offset", options.offset.toString());
        if (options.active !== undefined)
          params.append("active", options.active.toString());
        if (options.closed !== undefined)
          params.append("closed", options.closed.toString());
        if (options.order) params.append("order", options.order);
        if (options.ascending !== undefined)
          params.append("ascending", options.ascending.toString());
        if (options.end_date_min)
          params.append("end_date_min", options.end_date_min);
        if (options.end_date_max)
          params.append("end_date_max", options.end_date_max);
        for (const slug of options.slug ?? []) {
          params.append("slug", slug);
        }

        logger.debug(
          { slugCount: options.slug?.length, params: params.toString() },
          "Fetching markets from Gamma API",
        );
        const response = await this.gammaApi.get("/markets", { params });
        const markets = z.array(GammaMarketSchema).parse(response.data);
        logger.debug({ count: markets.length }, "Fetched markets");
        return markets;
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  async getMarketById(marketId: string): Promise<GammaMarket | null> {
    return withRetry(
      async () => {
        try {
          const response = await this.gammaApi.get(
            `/markets/${encodeURIComponent(marketId)}`,
          );
          return GammaMarketSchema.parse(response.data);
        } catch (error) {
          logger.warn(
            { marketId, error },
            "Primary market-by-id endpoint failed, trying fallback query",
          );
          const fallback = await this.gammaApi.get("/markets", {
            params: { id: marketId },
          });
          const markets = z.array(GammaMarketSchema).parse(fallback.data);
          return markets[0] ?? null;
        }
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  static parseClobTokenIds(market: GammaMarket): string[] {
    if (!market.clobTokenIds) return [];
    try {
      const parsed = JSON.parse(market.clobTokenIds);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static parseOutcomes(market: GammaMarket): string[] {
    if (!market.outcomes) return [];
    try {
      const parsed = JSON.parse(market.outcomes);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static parseOutcomePrices(market: GammaMarket): number[] {
    if (!market.outcomePrices) return [];
    try {
      const parsed = JSON.parse(market.outcomePrices);
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }

  /**
   * Parse the BTC target price from question text, e.g.
   * "Will BTC be above $97,450.00 at ...?". Returns null if not present.
   */
}

let clientInstance: PolymarketClient | null = null;
export function getPolymarketClient(): PolymarketClient {
  if (!clientInstance) clientInstance = new PolymarketClient();
  return clientInstance;
}
