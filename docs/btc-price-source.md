# Authoritative BTC Price Source and Window-Start Price

Reference for implementing BTC price handling in the real-money execution
system. Three sections, deliberately separated:

1. what the authoritative market source is,
2. how the simulator consumes it today,
3. the invariants a real-money implementation must preserve.

---

## 1. The authoritative source

**Polymarket BTC 5-minute Up/Down markets settle on the Chainlink BTC/USD
30-second TWAP.** Resolution is `Up` when the TWAP at window end is **greater
than or equal to** the TWAP at window open, otherwise `Down` (ties resolve
`Up`).

Evidence, all from Polymarket's own data:

| Source | Value |
|---|---|
| `market.resolutionSource` | `https://data.chain.link/streams/btc-usd-twap-30s-streams` |
| `market.cryptoMarketConfigId` | `btc-5m-twap-30` |
| `GET gamma-api.polymarket.com/crypto-market-configs` → that id | `{asset: "btc", duration: "5m", twapEnabled: true, twapLookbackSeconds: 30}` |
| `market.eventStartTime` | Window open instant, e.g. `2026-08-09T08:20:00Z` |

RTDS topic mapping, per [Chainlink TWAP
docs](https://docs.polymarket.com/market-data/chainlink-twap):

| Lookback | RTDS topic |
|---|---|
| 30 seconds | **`crypto_prices_twap_thirty`** ← 5m markets |
| 60 seconds | `crypto_prices_twap_sixty` — 15m markets |

### Why not `crypto_prices_chainlink`

Short note, because it is the one thing that could be repeated by mistake:
`crypto_prices_chainlink` is the raw (non-TWAP) Chainlink BTC/USD feed. It is not
in the TWAP topic table, and its payload carries no `window_s` field. Measured
against the 30s TWAP over 136 paired observations:

| median &#124;diff&#124; | p90 | max |
|---|---|---|
| $1.80 | $4.37 | $5.62 |

A ~$1.80 error in the price to beat is decisive when ~31% of 5-minute windows
finish within $5 of it. **Do not use this feed for these markets.**

### Why source consistency matters

The window-start price, the live price used for the entry decision, and the
window-end price must all come from the same feed on the same clock. If the
strike came from one basis and the live price from another, a constant offset
between the feeds would masquerade as a real BTC move — and during low-volatility
windows, where the entire open-to-close move can be a few cents, that offset
alone would decide the outcome.

The simulator therefore uses exactly one BTC feed for all three.

---

## 2. How the simulator consumes it

### Subscription

```json
{
  "action": "subscribe",
  "subscriptions": [
    {
      "topic": "crypto_prices_twap_thirty",
      "type": "update",
      "filters": "{\"symbol\":\"btc/usd\"}"
    }
  ]
}
```

`wss://ws-live-data.polymarket.com`, application-level `PING` text frame every
5 seconds. `filters` must be compact JSON, lowercase symbol, no spaces.

### Payload

```json
{
  "topic": "crypto_prices_twap_thirty",
  "type": "update",
  "timestamp": 1785178800123,
  "payload": {
    "symbol": "btc/usd",
    "value": 65000.5,
    "full_accuracy_value": "65000500000000000000000",
    "timestamp": 1785178800000,
    "window_s": 30
  }
}
```

| Field | Use |
|---|---|
| `payload.timestamp` | **Observation time.** The clock all window boundaries are compared against. |
| outer `timestamp` | When the publisher submitted to RTDS. Not used. |
| `payload.value` | The price we store. |
| `payload.full_accuracy_value` | Exact signed E18 fixed-point value. Measured difference from `value`: ~7×10⁻¹² USD — immaterial, so the simulator uses `value`. Available if exactness is ever required. |
| `payload.window_s` | `30`; confirms the correct topic. |

Observations arrive roughly once per second with a **~1.5–2.1 s publish lag**
behind their own observation time.

### Observation time vs arrival time

Two distinct clocks, used for two distinct purposes. Conflating them is the
subtle failure mode.

| Concern | Clock | Why |
|---|---|---|
| Price history and `currentPrice` timestamps | `payload.timestamp` (observation) | Window boundaries are instants defined by Polymarket; comparing them against arrival time selects an observation ~2 s stale |
| Freshness (`getPriceAgeMs`, `isPriceFresh`, staleness watchdog) | Arrival time | Measures *delivery*. Using observation time would show a permanent ~2 s age and misreport the normal publish lag as staleness |

```ts
private setPrice(price: number, observedAtMs: number): void {
  this.lastPriceReceivedMs = marketNow();     // arrival — freshness only
  if (observedAtMs < this.lastTimestamp) return;

  this.currentPrice = price;
  this.lastTimestamp = observedAtMs;
  this.priceHistory.push({ price, timestamp: observedAtMs });
  ...
}
```

The monotonic guard keeps `priceHistory` sorted by observation time, which
`getPriceAt()`'s binary search depends on.

Freshness threshold is 30 s; the watchdog force-reconnects past it, because RTDS
can stop sending while the TCP connection stays open.

### History buffer

In-memory, 1-hour TTL, pruned periodically.

| Accessor | Returns |
|---|---|
| `getPriceAt(t)` | Last observation with `timestamp <= t` (binary search), else `null` |
| `getHistoryBetween(from, to)` | Observations in the inclusive range |
| `getCurrentPrice()` | Newest observation and its observation timestamp |

**This topic sends no connect-time replay.** Per the docs: "Subscriptions start
with the next update. There is no snapshot, history, or replay after a
disconnect." A fresh process therefore begins with an empty buffer and can only
answer questions about instants after it connected.

### Window-start price ("price to beat")

`windowStart = market.endDate − windowDuration`.

`tryFillBtcWindowStart()` runs on every observation (`btcPriceUpdate`) for
markets awaiting a strike:

```ts
const windowStartMs = state.endDate.getTime() - this.windowDurationMs;
if (nowMs < windowStartMs) continue;              // window not open yet

const price = this.btcWatcher.getPriceAt(windowStartMs);
if (price === null) continue;                     // no observation → stays NULL

state.btcPriceAtWindowStart = price;
// strike propagates to the strategy engine
```

The `nowMs < windowStartMs` guard is load-bearing, not defensive: querying a
*future* boundary would return the newest observation, silently reintroducing a
current-price fallback.

### No fallback — by design

If the process starts or reconnects mid-window, there is no observation at that
window's open, `getPriceAt` returns `null`, and `btcPriceAtWindowStart` **stays
NULL**.

The market then never becomes tradeable, through existing behaviour only: the
strategy engine already returns early on `if (market.strike === null)`. **No
separate trading guard exists or is needed.**

There is deliberately:

- no fallback to the current BTC price,
- no secondary or approximating feed,
- no estimation of the missed observation.

A guessed strike is worse than no trade. The window is still recorded for
research with `btc_start_price = NULL`.

---

## 3. Invariants for the real-money system

| # | Invariant |
|---|---|
| 1 | Read the market's own `cryptoMarketConfigId` / `resolutionSource` rather than assuming a feed. Confirm `twapLookbackSeconds` and pick the matching RTDS topic. |
| 2 | For 5-minute markets that is `crypto_prices_twap_thirty` (30s). 15-minute markets need `crypto_prices_twap_sixty`. Never `crypto_prices_chainlink`. |
| 3 | One feed supplies the window-start, live, and window-end price. Never mix bases. |
| 4 | Index prices by `payload.timestamp` (observation time), never arrival time. |
| 5 | Track arrival time separately and use it — only it — for freshness and reconnect decisions. |
| 6 | The price to beat is the observation at the window-open instant. Guard against querying a boundary that has not occurred. |
| 7 | If that observation is missing, leave the strike unset and do not trade the market. No fallback, no approximation. |
| 8 | Keep `payload.full_accuracy_value` available if the venue ever requires exact E18 comparison; `value` is documented as display convenience. |

### Residual considerations for a real-money implementation

Known and accepted in simulation; worth revisiting when real capital is at risk.

- **`getPriceAt` has no staleness bound.** It returns the newest observation at
  or before the boundary however old that is. A feed gap spanning the boundary
  (history is retained across reconnects) could yield an observation tens of
  seconds stale. A maximum-age bound on the strike lookup would make this
  explicit rather than silent.
- **Clock dependence is narrow but real.** Prices carry Chainlink's own
  timestamps, so our host clock can no longer corrupt the strike. It still
  governs *when* we act — the entry-window countdown, window-open detection, and
  market lifecycle transitions all compare `marketNow()` against
  Polymarket-supplied instants. `marketNow()` is synced to `GET /time` on the
  CLOB; keep that sync. Chainlink observation timestamps are not a substitute:
  their variable ~2 s lag would replace a measured offset with an unmeasured one.
- **Window coverage after restart.** Because there is no replay, a restart
  forfeits the current window. Real-money deployment should expect this and
  prefer restarting between windows.
