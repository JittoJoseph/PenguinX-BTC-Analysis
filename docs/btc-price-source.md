# BTC Price Sources and the Settlement Forecast

This is a reference for the BTC price handling in the real-money execution
system. It has four sections:

1. the true market source,
2. the two feeds and what each one is for,
3. the settlement forecast,
4. the rules that a real-money implementation must obey.

---

## 1. The true source

The Polymarket BTC 15-minute Up/Down markets settle on the Chainlink BTC/USD
60-second TWAP. The result is `Up` when the TWAP at the window end is equal to or
more than the TWAP at the window open. If it is less, the result is `Down`.

All of the evidence comes from Polymarket data:

| Source | Value |
|---|---|
| `market.resolutionSource` | `https://data.chain.link/streams/btc-usd-twap-60s-streams` |
| `market.cryptoMarketConfigId` | `btc-15m-twap-60` |
| `GET gamma-api.polymarket.com/crypto-market-configs` for that ID | `{asset: "btc", duration: "15m", twapEnabled: true, twapLookbackSeconds: 60}` |
| `market.eventStartTime` | The window open instant |

Polymarket runs three BTC Up/Down durations and no others: `5m`, `15m` and `4h`.
There is no 1-hour market. The 5m markets use a 30-second TWAP; the 15m and 4h
markets both use 60 seconds.

The [Chainlink TWAP
documentation](https://docs.polymarket.com/market-data/chainlink-twap) gives the
RTDS topics:

| Lookback | RTDS topic |
|---|---|
| 30 seconds | `crypto_prices_twap_thirty` — the 5m markets |
| 60 seconds | **`crypto_prices_twap_sixty`** — the 15m and 4h markets |

---

## 2. The two feeds

The system subscribes to two topics. They do different jobs and you must not
substitute one for the other.

| Topic | What it is | What it is for |
|---|---|---|
| `crypto_prices_twap_sixty` | The settlement variable | The strike, the current level, the forecast anchor |
| `crypto_prices_chainlink` | The unsmoothed feed | Volatility, and the roll-off term |

CAUTION: Never settle against `crypto_prices_chainlink`, and never compare it to
the strike. It is not the value the market resolves on. A comparison against the
30s TWAP across 136 paired observations gave a median absolute difference of
$1.80 and a maximum of $5.62, which is enough to decide a close window.

### Why volatility must come from the raw feed

A 60-second TWAP is a moving average, so consecutive observations share 59 of
their 60 seconds of input. For a moving average of length *n* over a random walk,
`sd(delta TWAP) = sigma / sqrt(n)`. Volatility measured on TWAP ticks therefore
understates the true value by `sqrt(60)`, a factor of 7.75.

This is not a small correction and it is easy to miss, because the resulting
number looks plausible. Measured live, the raw feed gave `sigma = $4.01/s` while
the same estimator on TWAP ticks gave `$0.52/s`, a ratio of 7.7. A model built on
the TWAP-tick figure will believe every position is close to certain.

### Payload

```json
{
  "topic": "crypto_prices_twap_sixty",
  "type": "update",
  "timestamp": 1785178800123,
  "payload": {
    "symbol": "btc/usd",
    "value": 65000.5,
    "full_accuracy_value": "65000500000000000000000",
    "timestamp": 1785178800000,
    "window_s": 60
  }
}
```

| Field | Use |
|---|---|
| `payload.timestamp` | The observation time. All window boundaries compare against this clock. |
| outer `timestamp` | The time when the publisher sent the update. The system does not use it. |
| `payload.value` | The price the system writes. |
| `payload.window_s` | The value is `60`. It makes sure that the topic is correct. |

Both topics arrive at approximately one observation each second, approximately
1.5 to 2.1 seconds after the observation time they carry. Index every price by
`payload.timestamp`. Use arrival time only to decide whether the feed is stale.

---

## 3. The settlement forecast

Let `W` be the TWAP lookback in seconds and `tau` the seconds left in the window.

Because the TWAP is an average over `[end - W, end]`, its change from now to the
window end is the difference between the stretch that arrives and the stretch
that leaves:

```
TWAP_end - TWAP_now = (1/W) * ( integral of spot over [now, end]
                              - integral of spot over [now - W, now - W + tau] )
```

The second integral is entirely in the past, so it is known. The first has
expectation `tau * spot_now`. That gives:

```
E[TWAP_end] = TWAP_now + (min(tau, W) / W) * (spot_now - rollingOutMean)
sd[TWAP_end] = sigma_raw * sqrt(varFactor)
varFactor    = ((b^3 - a^3) / 3 - a^2 * (b - a)) / W^2 ,  a = max(0, tau - W), b = tau
```

`rollingOutMean` is the mean of the raw feed over `[now - W, now - W + tau]`.

The forecast anchors on the **published** TWAP and uses raw prices only for the
difference. This matters: Chainlink does not publish its sampling boundaries or
weighting, and the documentation says not to reproduce the value independently.
Anchoring this way needs no such reproduction, and a constant offset between our
raw integral and Chainlink's own cancels between the two terms.

Measured against live data, the residual matches the closed form closely:

| tau | R-squared | residual sd (measured) | residual sd (formula) | naive sd |
|---|---|---|---|---|
| 10s | 0.98 | $1.13 | $1.22 | $12.68 |
| 20s | 0.95 | $3.37 | $3.45 | $17.93 |
| 30s | 0.90 | $7.26 | $6.34 | $21.96 |
| 60s | 0.58 | $22.56 | $17.93 | $31.05 |

Beyond `tau = W` the roll-off term is zero and only the variance correction
remains, which is why the entry window closes at 50 seconds.

### Data gates

The forecast is only as good as its inputs, so three conditions block a trade:

- The raw feed must be fresher than `MAX_RAW_STALENESS_MS`.
- `rollingOutMean` returns null when its range is not fully covered by ticks
  close enough together to integrate. A feed gap must produce no trade rather
  than a confident wrong number.
- The strike must exist. A window whose open was not observed stays unstruck.

---

## 4. Rules for the real-money system

| # | Rule |
|---|---|
| 1 | Read `cryptoMarketConfigId` and `twapLookbackSeconds` from the market. Do not assume a feed. |
| 2 | Settle and strike against the TWAP topic that matches the lookback, never against `crypto_prices_chainlink`. |
| 3 | Measure volatility on the raw feed. A TWAP-tick estimate is low by `sqrt(W)`. |
| 4 | Compute the roll-off term from the raw feed, anchored on the published TWAP. Do not reproduce the TWAP from scratch. |
| 5 | Index each price by `payload.timestamp`. Keep arrival time separate and use it only for staleness. |
| 6 | Use the TWAP observation at the window-open instant as the strike. Do not query a boundary that did not occur. |
| 7 | If that observation is absent, leave the strike unset and do not trade the market. |
| 8 | Refuse to trade on a stale raw feed or an incompletely covered roll-off range. |
| 9 | Cap the model probability short of certainty. A Gaussian understates BTC jump risk. |

### Other points for a real-money system

- **There is no replay.** Subscriptions start with the next update, so a restart
  loses the current window's strike. Expect this and restart between windows.
- **`getTwapAt` has no age limit.** It returns the newest observation at or
  before the boundary at any age. A feed gap across a window open can therefore
  give a strike that is tens of seconds old. An age limit makes this visible
  instead of silent.
- **The host clock still matters.** Each price carries a Chainlink timestamp, so
  the host clock cannot corrupt the strike. It still controls when each action
  happens. Keep the `GET /time` sync to the CLOB.
