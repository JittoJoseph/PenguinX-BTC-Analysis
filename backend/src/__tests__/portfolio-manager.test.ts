import { describe, it, expect, beforeEach, vi } from "vitest";
import { PortfolioManager } from "../services/portfolio-manager.js";

vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => childLogger,
  };
  return {
    createModuleLogger: () => childLogger,
    getLogger: () => childLogger,
  };
});

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({
    portfolio: {
      startingCapital: 100,
    },
    logging: { level: "silent" },
    env: "test",
  }),
}));

let portfolioRow: { initialCapital: string; cashBalance: string } | null = null;

vi.mock("../db/client.js", () => ({
  getPortfolio: vi.fn(async () => portfolioRow),
  initPortfolio: vi.fn(async (startingCapital: number) => {
    if (!portfolioRow) {
      portfolioRow = {
        initialCapital: startingCapital.toString(),
        cashBalance: startingCapital.toString(),
      };
    }
    return portfolioRow;
  }),
  updateCashBalance: vi.fn(async (newBalance: string) => {
    if (portfolioRow) {
      portfolioRow.cashBalance = newBalance;
    }
    return portfolioRow;
  }),
}));

describe("PortfolioManager", () => {
  let pm: PortfolioManager;

  beforeEach(async () => {
    portfolioRow = null;
    pm = new PortfolioManager();
    await pm.init();
  });

  it("initialises with correct starting capital", () => {
    expect(pm.getCashBalance()).toBe(100);
    expect(pm.getInitialCapital()).toBe(100);
  });

  it("reload() refreshes from DB", async () => {
    portfolioRow!.cashBalance = "75.50";
    await pm.reload();
    expect(pm.getCashBalance()).toBe(75.5);
  });

  it("reload() throws if portfolio row is missing", async () => {
    portfolioRow = null;
    await expect(pm.reload()).rejects.toThrow("Portfolio row missing");
  });

  it("deductCash reduces balance and persists to DB", async () => {
    await pm.deductCash(19.5);
    expect(pm.getCashBalance()).toBeCloseTo(80.5, 2);
    expect(portfolioRow!.cashBalance).toBe("80.5");
  });

  it("deductCash goes negative rather than blocking the trade", async () => {
    await pm.deductCash(200);
    expect(pm.getCashBalance()).toBe(-100);
    expect(portfolioRow!.cashBalance).toBe("-100");
  });

  it("addCash increases balance and persists to DB", async () => {
    await pm.addCash(10.25);
    expect(pm.getCashBalance()).toBeCloseTo(110.25, 2);
    expect(portfolioRow!.cashBalance).toBe("110.25");
  });

  it("handles sequential deduct + add correctly", async () => {
    await pm.deductCash(20); // 80
    await pm.deductCash(15); // 65
    await pm.addCash(5); // 70
    expect(pm.getCashBalance()).toBe(70);
  });

  it("handles tiny amounts with precision", async () => {
    await pm.deductCash(99.999999);
    expect(pm.getCashBalance()).toBeCloseTo(0.000001, 6);
    await pm.addCash(0.000001);
    expect(pm.getCashBalance()).toBeCloseTo(0.000002, 6);
  });
});
