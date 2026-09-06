# Strategic Market Engine

[![Live Demo](https://img.shields.io/badge/Live_Demo-strategic--market--engine.vercel.app-007acc)](https://strategic-market-engine.vercel.app/)

[![Backend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=backend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Frontend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=frontend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Health Check](https://img.shields.io/website?url=https://market-api.jittojoseph.xyz/ping&label=health)](https://market-api.jittojoseph.xyz/ping)

A paper-trading simulator for Polymarket's BTC 15-minute Up/Down markets. It
watches live markets, works out when a window's outcome is already beyond
reversal, and buys the winning side whenever the order book is still quoting it
as if it were uncertain. Fills are simulated against the real order book.

No real money is traded.

## The edge

These markets resolve on the **Chainlink BTC/USD 60-second TWAP**: `Up` wins
when the TWAP at window close is at or above the TWAP at window open.

The strategy holds no view on where BTC is going and no probability model to
set against the market's. Both of those were tried and both lost: the book
consistently out-forecast the model in every uncertain window, because makers
watch exchange feeds that run about two seconds ahead of Chainlink.

What the book gets wrong is different. On thin windows, and during fast moves
when makers step away, resting orders placed before the move are left standing.
The move that made them stale also decided the outcome. A book still offering
the winning side at 0.50–0.65 with the window $100 past the strike is not a
forecast; it is an order nobody pulled. Those are the trades.

## How it works

Markets are discovered by deterministic slug (`btc-updown-15m-<windowStart>`)
and subscribed to over the CLOB WebSocket. Two RTDS feeds are consumed: the
`crypto_prices_twap_sixty` series that settlement runs on, and the unsmoothed
`crypto_prices_chainlink` series that drives it.

**Strike.** The TWAP observed at the window open, and nothing else. A window
whose open was not observed stays unstruck and is never traded.

**Forecast.** Inside the final minute the closing TWAP is a moving average that
has already absorbed most of its inputs, so its expected value is computable
from spot and the stretch about to roll out of the average. Beyond the final
minute the expectation is simply spot.

**Decided.** A window is decided when the forecast clears the strike by a floor
that depends on time to close:

| seconds to close | floor (basis points of price) |
|---|---|
| < 15 | 1.3 |
| 15–30 | 2.6 |
| 30–60 | 6.5 |
| 60–120 | 19.5 |
| 120–300 | 32.5 |
| > 300 | never |

The floor was calibrated on 383 real windows of 1-second BTC data as the
smallest margin at which the forecast side won 100% of the time, in every band,
on every day, in every volatility quartile. It is expressed in basis points so
it carries across price levels, and it is raised to seven model standard
deviations whenever that is larger, so volatile regimes demand more margin.
Nothing ever lowers it. There is no Gaussian anywhere: BTC's tails at these
horizons are hundreds of times fatter than one, and a trailing sigma measured
in a quiet minute makes small margins look certain.

**Entry.** From 300 seconds before close down to 5, on every settlement tick,
buy the decided side if its executable ask sits within `[0.15, 0.90]`. One
trade per window. Orders are held 250 ms and matched against the book as it
stands after the hold, which is what Polymarket does on these markets.

The price cap is what makes the risk arithmetic work. A stop is only a trigger
and the fill can be most of the position, so entries have to pay for that with
real upside. At 0.90 a win still returns 11%; near 0.50 it returns 100%. If the
book has repriced to 0.99, there is nothing to do.

**Exit.** A stop fires when the executable bid falls to 65% of the entry price;
otherwise the position rides to oracle resolution. The stop is always on and
cannot be disabled. The trigger is a fraction of entry rather than a fixed
number of cents because entries span 0.15 to 0.90: a 25c delta would be 28% of a
0.90 position, 83% of a 0.30 one, and unreachable below 0.25.

The trigger only decides *when* to sell. The order is matched against whatever
the bid side actually holds, walked to the bottom of the book with no limit, so
a collapsed book produces a near-total loss. There is no price floor and no
logic that can refuse a bad fill. A book too thin to absorb the whole position
leaves a remainder, which stays open with the trigger re-armed and is either
sold as liquidity returns or redeemed at settlement.

**Execution.** Simulated FAK taker orders walk the real ask side level by
level, so fills reflect actual depth, partial fills, slippage and fees. The
taker fee is Polymarket's published crypto schedule, `shares x 0.07 x p x (1-p)`.

All parameters are environment-tunable; see [`backend/.env.example`](backend/.env.example).

## Simulation settings

These exist to keep the research sample unbiased and are **not** intended for a
real-money system:

- Every entry uses a fixed **$5** budget regardless of portfolio value.
- Trades are never skipped for lack of cash; the simulated balance may go
  negative.
- There is no consecutive-loss auto-pause.

## Evaluation data

Every window writes one `audit_log` row under category `EVALUATION` at
cleanup: which side became decided and when, how many seconds it stayed
decided, and the cheapest ask the book offered on that side while it was —
whether or not that ask was inside the price band. Windows we skipped are the
baseline: that last number, across every window, is what says whether the price
cap sits where the opportunities are.

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

| Component   | Stack                                                       |
| ----------- | ----------------------------------------------------------- |
| Backend     | Node.js 22+, TypeScript, PostgreSQL (Supabase) via Drizzle  |
| Frontend    | Next.js dashboard, live updates over WebSocket              |
| Market data | Polymarket Gamma API, CLOB WebSocket, RTDS TWAP + raw feeds |

Backend services are single-purpose and wired through one orchestrator: market
scanner, CLOB book watcher, BTC price watcher, strategy engine, execution
simulator, portfolio manager, API server.

Window boundaries and entry deadlines are defined by Polymarket, so the engine
runs on a market clock synced to the CLOB server rather than the host clock.
