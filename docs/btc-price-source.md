# Authoritative BTC Price Source and Window-Start Price

This is a reference for the BTC price handling in the real-money execution
system. It has three sections:

1. the true market source,
2. how the simulator uses that source today,
3. the rules that a real-money implementation must obey.

---

## 1. The true source

The Polymarket BTC 5-minute Up/Down markets settle on the Chainlink BTC/USD
30-second TWAP. The result is `Up` when the TWAP at the window end is equal to
or more than the TWAP at the window open. If it is less, the result is `Down`.
A tie gives `Up`.

All of the evidence comes from Polymarket data:

| Source | Value |
|---|---|
| `market.resolutionSource` | `https://data.chain.link/streams/btc-usd-twap-30s-streams` |
| `market.cryptoMarketConfigId` | `btc-5m-twap-30` |
| `GET gamma-api.polymarket.com/crypto-market-configs` for that ID | `{asset: "btc", duration: "5m", twapEnabled: true, twapLookbackSeconds: 30}` |
| `market.eventStartTime` | The window open instant, for example `2026-08-09T08:20:00Z` |

The [Chainlink TWAP
documentation](https://docs.polymarket.com/market-data/chainlink-twap) gives the
RTDS topics:

| Lookback | RTDS topic |
|---|---|
| 30 seconds | **`crypto_prices_twap_thirty`** — the 5m markets |
| 60 seconds | `crypto_prices_twap_sixty` — the 15m markets |

### Do not use `crypto_prices_chainlink`

CAUTION: Do not use the `crypto_prices_chainlink` topic for these markets. This
topic is the raw Chainlink BTC/USD feed, not the TWAP. It is not in the topic
table above, and its payload has no `window_s` field.

A comparison against the 30s TWAP across 136 paired observations gives:

| median absolute difference | p90 | maximum |
|---|---|---|
| $1.80 | $4.37 | $5.62 |

An error of approximately $1.80 in the price to beat is large. Approximately
31% of 5-minute windows end within $5 of the price to beat.

### Why one source is necessary

The window-start price, the live price for the entry decision, and the
window-end price must come from the same feed on the same clock.

Assume that the strike comes from one feed and the live price from a different
feed. Then a constant offset between the two feeds looks like a true BTC move.
In a window with low volatility the full move can be a few cents. The offset
alone can then decide the result.

The simulator therefore uses one BTC feed for all three prices.

---

## 2. How the simulator uses the source

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

The endpoint is `wss://ws-live-data.polymarket.com`. The client sends the text
frame `PING` every 5 seconds. The `filters` value must be compact JSON with a
lowercase symbol and no spaces.

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
| `payload.timestamp` | The observation time. All window boundaries compare against this clock. |
| outer `timestamp` | The time when the publisher sent the update to RTDS. The simulator does not use it. |
| `payload.value` | The price that the simulator writes. |
| `payload.full_accuracy_value` | The exact signed E18 fixed-point value. It differs from `value` by approximately 7×10⁻¹² USD. This difference is too small to matter, so the simulator uses `value`. |
| `payload.window_s` | The value is `30`. It makes sure that the topic is correct. |

An observation arrives approximately once each second. It arrives approximately
1.5 to 2.1 seconds after its own observation time.

### Observation time and arrival time

These are two different clocks for two different purposes. A mix of the two is
the failure that is most difficult to see.

| Purpose | Clock | Reason |
|---|---|---|
| The price history and the `currentPrice` timestamps | `payload.timestamp`, the observation time | Polymarket defines the window boundaries. A comparison against arrival time selects an observation that is approximately 2 seconds old. |
| Freshness: `getPriceAgeMs`, `isPriceFresh`, the staleness watchdog | Arrival time | This measures delivery. The observation time always shows an age of approximately 2 seconds and makes the normal publish lag look like a fault. |

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

The monotonic guard keeps `priceHistory` in order of observation time. The
binary search in `getPriceAt()` needs this order.

The freshness limit is 30 seconds. Above this limit the watchdog makes a new
connection. RTDS can stop transmission while the TCP connection stays open.

### The history buffer

The buffer is in memory. It has a TTL of 1 hour. The code prunes it at
intervals.

| Accessor | Result |
|---|---|
| `getPriceAt(t)` | The last observation with `timestamp <= t`, found by binary search. If there is none, the result is `null`. |
| `getHistoryBetween(from, to)` | The observations in the inclusive range |
| `getCurrentPrice()` | The newest observation and its observation timestamp |

This topic sends no history at connect time. The documentation is clear:
"Subscriptions start with the next update. There is no snapshot, history, or
replay after a disconnect." A new process therefore starts with an empty buffer.
It can answer questions only about instants after it connected.

### The window-start price, or price to beat

The window start is `market.endDate` minus the window duration.

`tryFillBtcWindowStart()` runs on each observation, the `btcPriceUpdate` event,
for each market that has no strike:

```ts
const windowStartMs = state.endDate.getTime() - this.windowDurationMs;
if (nowMs < windowStartMs) continue;              // window not open yet

const price = this.btcWatcher.getPriceAt(windowStartMs);
if (price === null) continue;                     // no observation → stays NULL

state.btcPriceAtWindowStart = price;
// strike propagates to the strategy engine
```

The guard `nowMs < windowStartMs` is necessary, not defensive. A query for a
boundary in the future returns the newest observation. That result is the
current price, which this design removes.

### There is no fallback

Assume that the process starts or connects again in the middle of a window.
Then there is no observation at the open of that window. `getPriceAt` returns
`null` and `btcPriceAtWindowStart` stays NULL.

The market then never becomes tradeable. This occurs through existing behaviour
only, because the strategy engine returns early on
`if (market.strike === null)`. No separate trading guard is necessary.

The design has none of these:

- a fallback to the current BTC price,
- a second feed or an approximate feed,
- a calculation of the observation that the process did not receive.

A strike that comes from a calculation is worse than no trade. The simulator
still writes a record for the window, with `btc_start_price = NULL`.

---

## 3. Rules for the real-money system

| # | Rule |
|---|---|
| 1 | Read `cryptoMarketConfigId` and `resolutionSource` from the market. Do not assume a feed. |
| 2 | Read `twapLookbackSeconds` and select the RTDS topic that agrees with it. |
| 3 | For a 5-minute market, use `crypto_prices_twap_thirty`. For a 15-minute market, use `crypto_prices_twap_sixty`. Never use `crypto_prices_chainlink`. |
| 4 | Use one feed for the window-start price, the live price, and the window-end price. Never mix two feeds. |
| 5 | Index each price by `payload.timestamp`, the observation time. Never index by arrival time. |
| 6 | Keep the arrival time separate. Use the arrival time only for freshness and for reconnect decisions. |
| 7 | Use the observation at the window-open instant as the price to beat. Do not query a boundary that did not occur. |
| 8 | If that observation is absent, leave the strike unset and do not trade the market. |
| 9 | Keep `payload.full_accuracy_value` available. The venue can need an exact E18 comparison later. |

### Other points for a real-money system

The simulator accepts these three points. Examine them again when real money is
at risk.

- **`getPriceAt` has no age limit.** It returns the newest observation at or
  before the boundary, at any age. The history stays in memory across a
  reconnect. Therefore a gap in the feed across a boundary can give an
  observation that is tens of seconds old. An age limit on the strike lookup
  makes this condition clear instead of silent.
- **The clock dependency is small but real.** Each price carries a Chainlink
  timestamp, so the host clock cannot corrupt the strike. The host clock still
  controls the time of each action. The entry-window countdown, the window-open
  test, and the market lifecycle steps all compare `marketNow()` against
  instants from Polymarket. `marketNow()` syncs to `GET /time` on the CLOB. Keep
  this sync. Chainlink observation timestamps cannot replace it, because their
  variable lag of approximately 2 seconds replaces a measured offset with an
  offset that nobody measures.
- **Window coverage after a restart.** There is no replay, so a restart loses
  the current window. Expect this behaviour and restart between windows.
