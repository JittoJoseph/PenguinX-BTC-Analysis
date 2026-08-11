# Market Regime Data Collection

## Purpose

The simulator writes one record for each completed 5-minute market. It writes a
record for every market, traded or not.

Later you can join these records to `simulated_trades`. The join shows which
market conditions give good or bad strategy results.

The table holds measurements only. It holds no regime labels, no
classifications, no scores, and no conclusions. Interpretation is an analysis
step, not a collection step.

Two properties make the data usable:

- **Market-centric.** The simulator writes a record for every window that it
  watches. Without the untraded windows there is no baseline.
- **Unbiased sample.** The simulator writes the record even when no entry
  occurs. The fill result and the profit do not change this.

## Table: `market_regime_data`

The table holds one record for each completed market window. The column
`market_id` is unique. Therefore the simulator cannot write one market twice.

### Identity and time

| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | UUID |
| `market_id` | text, **unique** | The Polymarket market ID. This is the idempotency key. |
| `slug` | text | For example, `btc-updown-5m-1786263600` |
| `window_type` | text | The market window from the configuration, for example `5M` |
| `window_start` | timestamp | `window_end` minus the window duration |
| `window_end` | timestamp | The `endDate` of the market |
| `created_at` | timestamp | The time of the record insert |

The table keeps `slug`, `window_type`, and the two window times for a reason.
The `markets` table gets a row only when a trade opens. An untraded window
therefore has no row to join to. These columns make the data set independent.

### BTC measurements across the window

The simulator calculates all of these values from the in-memory TWAP
observation buffer for the range `[window_start, window_end]`. Read
[btc-price-source.md](./btc-price-source.md) for the source of the observations.

| Column | Type | Meaning |
|---|---|---|
| `btc_start_price` | decimal(18,2) | The price to beat. This is the TWAP observation at the window open. The value is NULL when the simulator did not capture that observation. |
| `btc_end_price` | decimal(18,2) | The last observation at or before `window_end` |
| `btc_high_price` | decimal(18,2) | The highest observation in the window |
| `btc_low_price` | decimal(18,2) | The lowest observation in the window |
| `btc_sigma_per_sec` | decimal(18,8) | Realized volatility across the window in $/s. The formula is `sqrt(Σ Δprice² / Σ Δt_seconds)`. |
| `btc_strike_crossings` | integer | The number of times that BTC crosses `btc_start_price`. The value is NULL when the start price is NULL. |
| `btc_tick_count` | integer | The number of observations that give the values above |

`btc_tick_count` shows how much you can trust the other BTC columns. A 5-minute
window usually gives approximately 290 observations, or one each second. A low
count means that the buffer did not cover the window.

The table keeps the high price, the low price, and the crossings for a reason.
The start price and the end price together cannot show the difference between
two windows. One window can move $80 in one direction. A different window can
move $80 and then come back.

The table holds no calculated values. There is no `btc_move` column, because it
is `btc_end_price` minus `btc_start_price`.

### Outcome columns

| Column | Type | Meaning |
|---|---|---|
| `winning_outcome` | text | `Up` or `Down`. This is the true resolution from Polymarket. The value is NULL until the market resolves. |
| `trade_taken` | boolean | Shows if the strategy entered this market |
| `outcome` | text | `WIN`, `LOSS`, or NULL |

## `trade_taken` and `outcome`

The simulator gets both values from `getMarketTradeSummary(marketId)`. This
function reads `simulated_trades` by `market_id` at the time of the write. It
does not use in-memory data. Therefore the values stay correct after a restart.

| Condition | `trade_taken` | `outcome` |
|---|---|---|
| The market has no trades | `false` | `NULL` |
| The market has one or more trades | `true` | `WIN` when the net realized PnL is more than 0, `LOSS` when it is not |

`outcome` has a meaning only when `trade_taken` is `true`. A market can hold one
open trade for each token. When more than one trade exists, the net realized
PnL gives the result.

These two columns show strategy performance. They are independent of
`winning_outcome`. A trade can lose on a market where `winning_outcome` is the
side that the simulator bought, because a stop-loss exit can occur first.

## `winning_outcome` and asynchronous resolution

Polymarket does not publish the resolution immediately. Measurement shows that a
market is still unresolved 3 minutes after the window closes. The market usually
resolves in approximately 15 minutes. The simulator writes the record
approximately 10 seconds after the close. At that time the true result does not
exist.

The sequence is:

1. The simulator writes each record with `winning_outcome = NULL`. It does no
   synchronous lookup. It makes no calculation from BTC prices.
2. `resolvePendingOutcomes()` runs as a background step after a market closes.
   It selects a maximum of 40 records where `winning_outcome IS NULL`, with the
   oldest `window_end` first.
3. The function sends one request, `GET /markets?closed=true&slug=…`. Gamma
   returns a market under `closed=true` only after settlement. Then exactly one
   `outcomePrices` entry is `"1"`. The matching entry of `outcomes` is the
   winner.
4. The function updates the resolved records. Only two winners are possible.
   Therefore this needs a maximum of two `UPDATE` statements.
5. Records that Polymarket did not resolve are not in the response. They stay
   NULL. A later market-close cycle examines them again.

A module-level `resolving` flag makes an overlapping call a no-op. One cleanup
tick can close more than one market.

The sweep examines all NULL records, not only the market that closed last.
Therefore an old backlog clears without help, at 40 records for each cycle.

## Lifecycle and time

`cleanupMarket()` is the one point that each market passes through when it
leaves the active set. The function does not run while the market has open
positions. Therefore, when it runs, the window is complete and all trades are
settled. This is the correct moment for the snapshot.

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

The code awaits nothing. `cleanupMarket` continues immediately. Therefore the
cleanup and the start of the next active market never wait for a database write
or a Polymarket request. The code writes a failure to the log and does no more.

## Architecture rules

| Rule | How the code obeys it |
|---|---|
| Independent of trading | The entry, the execution, the stop-loss, and the sizing do not read or write this table |
| No interference | One hook, fire-and-forget. The code only logs an error. The cleanup path awaits nothing. |
| True resolution | `winning_outcome` comes only from the Polymarket API. The code never calculates it from BTC prices. |
| Central | All of the logic is in `market-recorder.ts`, with two accessors in `db/client.ts` |
| Idempotent | A unique index on `market_id`, with `onConflictDoNothing` |
| Eventually consistent | Each record is complete except `winning_outcome`, which fills in on a later cycle |
| Simple scalars | No arrays, no nested metrics, no labels, no calculated regime data |

## Analysis notes

- Join to `simulated_trades` on `market_id` to get the entry price, the fees,
  and the PnL.
- Examine `btc_tick_count` before you use the BTC columns. If the count is low,
  remove the record from the analysis.
- Records with `btc_start_price IS NULL` were never tradeable. Use them for
  baseline statistics.
- Some records can keep `winning_outcome IS NULL` permanently. This occurs when
  Polymarket never resolves them to `1` or `0`.
