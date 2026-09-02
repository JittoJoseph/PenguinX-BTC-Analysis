# Strategic Market Engine

[![Live Demo](https://img.shields.io/badge/Live_Demo-strategic--market--engine.vercel.app-007acc)](https://strategic-market-engine.vercel.app/)

[![Backend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=backend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Frontend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=frontend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Health Check](https://img.shields.io/website?url=https://market-api.jittojoseph.xyz/ping&label=health)](https://market-api.jittojoseph.xyz/ping)

A paper-trading simulator for Polymarket's BTC 15-minute Up/Down markets. It
watches live markets, forecasts the value the market settles on, buys whichever
side the book misprices, and simulates fills against the real order book.

No real money is traded.

## The edge

These markets resolve on the **Chainlink BTC/USD 60-second TWAP**: `Up` wins
when the TWAP at window close is at or above the TWAP at window open.

A 60-second TWAP is a moving average, so inside the final minute part of the
closing value is already fixed by prices that have happened. Over the next `tau`
seconds the average sheds its oldest `tau` seconds and takes on `tau` seconds of
new price, which makes its expected move computable rather than random:

```
E[TWAP_close] = TWAP_now + (tau / 60) * (spot_now - mean of the stretch rolling out)
```

Only the incoming stretch is unknown, and because it arrives as an average its
variance grows with `tau^3` rather than `tau`:

```
sd[TWAP_close] = sigma_raw * tau^1.5 / (sqrt(3) * 60)
```

Both effects are large. Measured against live Chainlink data, the roll-off term
predicts the TWAP 10 seconds out with an R-squared of 0.98, cutting mean absolute
error by 88% versus reading the current TWAP; at 30 seconds it is still 0.90.
Settlement uncertainty comes out roughly 3.5x tighter than a random-walk model
says at 30 seconds out, and the measured residual matches the closed form above
almost exactly.

None of this is a view on where BTC is going. It is a statement about a smoothed
series whose recent history is already observable. When the resulting probability
lands far enough from what the book is charging, that gap is the trade.

## How it works

Markets are discovered by deterministic slug (`btc-updown-15m-<windowStart>`) and
subscribed to over the CLOB WebSocket. Two RTDS feeds are consumed: the
`crypto_prices_twap_sixty` series that settlement runs on, and the unsmoothed
`crypto_prices_chainlink` series that drives it. Volatility and the roll-off term
both come from the raw feed, because measuring either on the TWAP understates it
by a factor of sqrt(60).

**Strike.** The TWAP observed at the window open, and nothing else. A window
whose open was not observed stays unstruck and is never traded.

**Entry.** Between 50 and 10 seconds before close, each market is scored on every
settlement tick. Buy when the model probability for a side beats its executable
ask by at least 6 points, the forecast clears the strike by at least 0.35
settlement standard deviations, and the ask sits within `[0.15, 0.90]`. One trade
per window.

The price cap is what makes the risk arithmetic work. A stop is only a trigger —
the fill lands wherever liquidity is, and near expiry that can be most of the
position — so entries have to pay for that possibility with real upside. At 0.90
a win still returns 11%; nearer 0.50 it returns 100%.

**Exit.** A stop fires when the executable bid falls to 65% of the entry price,
otherwise the position rides to oracle resolution. The stop is always on and
cannot be disabled.

The trigger is a fraction of entry rather than a fixed number of cents because
entries span 0.15 to 0.90. A 25c delta is 28% of a 0.90 position, 83% of a 0.30
one, and unreachable below 0.25 — which would leave the cheapest positions with
no stop at all. A fraction holds the risk per position constant across the band.

The trigger only decides *when* to sell. The order is then matched against
whatever the bid side actually holds, walked to the bottom of the book with no
limit, so a collapsed book produces a near-total loss. There is no price floor
and no logic that can refuse a bad fill. A book too thin to absorb the whole
position leaves a remainder, which stays open with the trigger re-armed and is
either sold as liquidity returns or redeemed at settlement.

**Execution.** Simulated FAK taker orders walk the real ask side level by level,
so fills reflect actual depth, partial fills, slippage and fees. The taker fee is
Polymarket's published crypto schedule, `shares x 0.07 x p x (1-p)`, which peaks
at 50c — precisely where this strategy trades most.

All parameters are environment-tunable; see [`backend/.env.example`](backend/.env.example).

## Simulation settings

These exist to keep the research sample unbiased and are **not** intended for a
real-money system:

- Every entry uses a fixed **$5** budget regardless of portfolio value.
- Trades are never skipped for lack of cash; the simulated balance may go
  negative.
- There is no consecutive-loss auto-pause.

## Evaluation data

Every window that reaches the entry stage writes one `audit_log` row under
category `EVALUATION`, holding both sides' ask, model probability, edge, forecast
margin, forecast sd and the reason no trade was taken. Windows we skipped are the
baseline: without them there is no way to tell a filter that works from one that
simply never fires.

## Admin operations

Three endpoints, all requiring the admin password.

| Action | Effect |
|---|---|
| `POST /api/admin/pause` | Stops new entries. Open positions stay tracked, keep their stop armed, and still settle. The price feed and order-book subscriptions stay live. |
| `POST /api/admin/resume` | Reloads the portfolio row, restarts the scanner, resumes entries. |
| `DELETE /api/admin/wipe` | Pauses, clears all in-memory session state, deletes trades, audit log, markets and the portfolio row, then reloads the fresh portfolio. Leaves the engine **paused**. |

**Wipe then resume is enough — a process restart is not required.** The wipe
clears open positions, active markets, settlement timers, order-book
subscriptions, the scanner's seen-market memo and the strategy engine's
traded-market set before it touches the database, so nothing from the old
session survives to act against the new portfolio. Resume then rediscovers
markets from scratch.

Resuming is in one respect better than restarting: the BTC price buffer lives in
memory and is not cleared, so a window whose open is still inside the buffer
gets its strike back immediately. A restart loses that and skips the window.

Pause is deliberately not a full stop. Positions opened before the pause must
still be able to hit their stop and settle, so those paths are not gated on the
paused flag.

## Architecture

| Component   | Stack                                                      |
| ----------- | ---------------------------------------------------------- |
| Backend     | Node.js 22+, TypeScript, PostgreSQL (Supabase) via Drizzle |
| Frontend    | Next.js dashboard, live updates over WebSocket             |
| Market data | Polymarket Gamma API, CLOB WebSocket, RTDS TWAP + raw feeds |

Backend services are single-purpose and wired through one orchestrator: market
scanner, CLOB book watcher, BTC price watcher, strategy engine, execution
simulator, portfolio manager, API server.

Window boundaries and entry deadlines are defined by Polymarket, so the engine
runs on a market clock synced to the CLOB server rather than the host clock.
