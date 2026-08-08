import Decimal from "decimal.js";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import {
  getPortfolio,
  initPortfolio,
  updateCashBalance,
} from "../db/client.js";

const logger = createModuleLogger("portfolio-manager");

export class PortfolioManager {
  private cashBalance: Decimal = new Decimal(0);
  private initialCapital: Decimal = new Decimal(0);

  /** Initialise from DB or create fresh portfolio row. */
  async init(): Promise<void> {
    const config = getConfig();
    const portfolio = await initPortfolio(config.portfolio.startingCapital);
    if (!portfolio) {
      throw new Error("Failed to initialise portfolio row");
    }
    this.cashBalance = new Decimal(portfolio.cashBalance);
    this.initialCapital = new Decimal(portfolio.initialCapital);
    logger.info(
      {
        initialCapital: this.initialCapital.toString(),
        cashBalance: this.cashBalance.toString(),
      },
      "Portfolio initialised",
    );
  }

  /** Reload cash balance from DB (e.g. after a wipe). */
  async reload(): Promise<void> {
    const portfolio = await getPortfolio();
    if (!portfolio) {
      throw new Error("Portfolio row missing — call init() first");
    }
    this.cashBalance = new Decimal(portfolio.cashBalance);
    this.initialCapital = new Decimal(portfolio.initialCapital);
  }

  getCashBalance(): number {
    return this.cashBalance.toNumber();
  }

  getInitialCapital(): number {
    return this.initialCapital.toNumber();
  }

  /**
   * Deduct fill cost after a buy. The research run never blocks a trade on
   * available cash, so the balance is allowed to go negative — see
   * FIXED_POSITION_BUDGET_USD.
   */
  async deductCash(amount: number): Promise<void> {
    this.cashBalance = this.cashBalance.minus(new Decimal(amount));
    await updateCashBalance(this.cashBalance.toString());
    logger.debug(
      { deducted: amount, remaining: this.cashBalance.toString() },
      "Cash deducted",
    );
  }

  /** Add cash back after a position is resolved or exited. */
  async addCash(amount: number): Promise<void> {
    const dec = new Decimal(amount);
    this.cashBalance = this.cashBalance.plus(dec);
    await updateCashBalance(this.cashBalance.toString());
    logger.debug(
      { added: dec.toString(), newBalance: this.cashBalance.toString() },
      "Cash added",
    );
  }
}
