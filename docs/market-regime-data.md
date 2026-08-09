# Market Regime Data Collection

## Purpose

For every completed 5-minute market — traded or not — the simulator writes one
row of objective, market-level measurements. Joined later against
`simulated_trades`, this lets us ask which market conditions the strategy
performs well or badly in.

The table stores **measurements only**. No regime labels, classifications,
scores, or conclusions are stored. Interpretation happens at analysis time, not
collection time.

Two properties make the dataset usable:

- **Market-centric** — every window we watched is recorded, not only the ones we
  traded. Without the untraded windows there is no baseline to compare against.
- **Unbiased sampling** — the record is written regardless of whether an entry
  fired, filled, or was profitable.

## Table: `market_regime_data`

One row per completed market window. `market_id` is unique, so a market cannot
be recorded twice.

### Identity and timing

| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | UUID |
| `market_id` | text, **unique** | Polymarket market id; the idempotency key |
| `slug` | text | e.g. `btc-updown-5m-1786263600` |
| `window_type` | text | Configured market window, e.g. `5M` |
| `window_start` | timestamp | `window_end − window duration` |
| `window_end` | timestamp | The market's `endDate` |
| `created_at` | timestamp | Row insert time |

`slug`, `window_type` and the window timestamps are kept here deliberately. The
`markets` table is only written when a trade opens, so untraded windows have no
row to join to; these columns are what make the dataset standalone.

### BTC measurements over the window

All derived from the in-memory TWAP observation buffer for
`[window_start, window_end]`. See [btc-price-source.md](./btc-price-source.md).

| Column | Type | Meaning |
|---|---|---|
| `btc_start_price` | decimal(18,2) | The price to beat — the TWAP observation at window open. NULL when that observation was never captured (e.g. process started mid-window). |
| `btc_end_price` | decimal(18,2) | Last observation at or before `window_end` |
| `btc_high_price` | decimal(18,2) | Highest observation in the window |
| `btc_low_price` | decimal(18,2) | Lowest observation in the window |
| `btc_sigma_per_sec` | decimal(18,8) | Realized volatility over the window, `sqrt(Σ Δprice² / Σ Δt_seconds)`, in $/s |
| `btc_strike_crossings` | integer | Number of times BTC crossed `btc_start_price` (sign flips of `price − start`). NULL when the start price is NULL. |
| `btc_tick_count` | integer | Observations the four values above are computed from |

`btc_tick_count` is the trust indicator. A 5-minute window normally yields
~290 observations (~1/s). A low count means the buffer did not cover the window
and the other BTC columns should be filtered out at analysis time.

High/low and crossings are stored because start/end alone cannot distinguish a
window that drifted $80 from one that whipsawed $80 and came back.

Nothing derivable is stored — there is no `btc_move` column, since it is
`btc_end_price − btc_start_price`.

### Outcome fields

| Column | Type | Meaning |
|---|---|---|
| `winning_outcome` | text | `Up` / `Down` — Polymarket's actual resolution. NULL until resolved. |
| `trade_taken` | boolean | Whether the strategy entered this market |
| `outcome` | text | `WIN` / `LOSS`, or NULL |

## `trade_taken` and `outcome`

Both come from `getMarketTradeSummary(marketId)`, which reads
`simulated_trades` by `market_id` at record time — not from in-memory state, so
the values survive restarts.

| Condition | `trade_taken` | `outcome` |
|---|---|---|
| No trades for the market | `false` | `NULL` |
| One or more trades | `true` | `WIN` if net realized PnL > 0, else `LOSS` |

`outcome` is only meaningful when `trade_taken = true`. A market can hold up to
one open trade per token, so when several exist the result is decided by their
**net** realized PnL.

These are strategy-performance fields. They are independent of
`winning_outcome`: a trade can lose on a market whose `winning_outcome` was the
side we bought (stop-loss exit), and can win on either side.

## `winning_outcome` and asynchronous resolution

Polymarket does not publish a resolution immediately. Measured: a market is
still unresolved 3 minutes after its window closes, and resolves within roughly
15 minutes. The record is written ~10 seconds after close, so the authoritative
result does not exist yet.

Therefore:

1. Every row is inserted with `winning_outcome = NULL`. No synchronous lookup,
   no inference from BTC prices.
2. `resolvePendingOutcomes()` runs as a background step triggered by market
   close. It selects up to **40** rows with `winning_outcome IS NULL`, oldest
   `window_end` first.
3. It queries `GET /markets?closed=true&slug=…` for those slugs in one request.
   Gamma only returns a market under `closed=true` once it has settled, and then
   exactly one `outcomePrices` entry is `"1"`. The winner is the matching entry
   of `outcomes`.
4. Resolved rows are updated. Because only two winners exist, this is at most
   two `UPDATE` statements.
5. Rows Polymarket has not resolved are simply absent from the response and stay
   NULL, to be retried on a later market-close cycle.

A module-level `resolving` flag makes overlapping invocations no-ops, since one
cleanup tick can close several markets at once.

Because the sweep scans **all** NULL rows rather than only the market that just
closed, any historical backlog drains on its own at 40 rows per cycle.

## Lifecycle and timing

`cleanupMarket()` is the single point every market passes through on its way out
of the active set. It already refuses to run while the market has open
positions, so by the time it fires the window has ended **and** all trades are
settled — exactly the right moment to snapshot.

```
window ends
  → cleanupExpiredMarkets() (every 10s) sees endDate passed and no open positions
  → cleanupMarket()
      ├── recordCompletedMarket(...)         insert row, winning_outcome = NULL
      │     └── resolvePendingOutcomes()     fill NULL rows Polymarket has settled
      └── unsubscribe, unregister, drop from activeMarkets   (synchronous)
```

Both data steps are fire-and-forget:

```ts
recordCompletedMarket({...}, this.btcWatcher)
  .catch(err => logger.error(...))
  .then(() => resolvePendingOutcomes())
  .catch(err => logger.error(...));
```

Nothing is awaited. `cleanupMarket` continues synchronously, so **cleanup and
promotion of the next active market never wait on a database write or a
Polymarket request.** Failures are logged and nothing else.

## Architectural principles

| Principle | How it holds |
|---|---|
| Independent of trading | Entry, execution, stop-loss and sizing neither read nor write this table |
| Never interferes | Fire-and-forget from one hook; errors are logged only; no awaits on the cleanup path |
| Authoritative resolution | `winning_outcome` comes only from Polymarket's API, never inferred from BTC prices |
| Centralized | All of it lives in `market-recorder.ts` plus two accessors in `db/client.ts` |
| Idempotent | Unique index on `market_id` with `onConflictDoNothing` |
| Eventually consistent | Rows are complete except `winning_outcome`, which converges over later cycles |
| Simple scalars | No arrays, nested metrics, labels, or derived regime information |

## Analysis notes

- Join to `simulated_trades` on `market_id` for entry price, fees, and PnL.
- Filter on `btc_tick_count` before trusting the BTC columns.
- Rows with `btc_start_price IS NULL` were never tradeable by design; they are
  still valid market observations for baseline statistics.
- A small number of rows may hold `winning_outcome IS NULL` indefinitely if
  Polymarket never resolves them to a clean 1/0.
