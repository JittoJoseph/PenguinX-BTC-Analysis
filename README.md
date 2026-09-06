# Strategic Market Engine

[![Live Demo](https://img.shields.io/badge/Live_Demo-strategic--market--engine.vercel.app-007acc)](https://strategic-market-engine.vercel.app/)

[![Backend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=backend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Frontend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=frontend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Health Check](https://img.shields.io/website?url=https://market-api.jittojoseph.xyz/ping&label=health)](https://market-api.jittojoseph.xyz/ping)

A paper-trading simulator for Polymarket's BTC 15-minute Up/Down markets. It
watches live markets, works out which side the settlement is heading for, and
buys that side as a taker when the book still prices it as a discount. Fills are
simulated against the real order book.

No real money is traded.

## The strategy

These markets resolve on the **Chainlink BTC/USD 60-second TWAP**: `Up` wins
when the TWAP at window close is at or above the TWAP at window open.

The engine holds no view on where BTC is going. It waits until the window is
most of the way through, asks a single question — how far is the settlement
forecast from the strike, relative to what the time left can still move it —
and buys the favoured side if the book offers it below 0.85.

It is deliberately not a certainty detector. A floor strict enough to be never
wrong (100% on 383 real windows) turned out to be useless in practice: by the
time the margin clears it, the book has already repriced to 1.00 and there is
nothing to buy. The floor used here is 0.4× that calibrated table, the point
where side accuracy is still ~98% but entries land around 0.5 a few times a
day. That trade-off — a rare loss that the stop turns into a partial one,
against wins that roughly double the stake — is the whole bet.

## How it works

Markets are discovered by deterministic slug (`btc-updown-15m-<windowStart>`)
and subscribed to over the CLOB WebSocket. Two RTDS feeds are consumed: the
`crypto_prices_twap_sixty` series that settlement runs on, and the unsmoothed
`crypto_prices_chainlink` series that drives it.

**Strike.** The TWAP observed at the window open. A window whose open was not
observed stays unstruck and is never traded.

**Forecast.** Inside the final minute the closing TWAP is a moving average that
has already absorbed most of its inputs, so its expected value is computable
from spot and the stretch about to roll out of the average. Beyond the final
minute the expectation is simply spot.

**Favoured.** A side is favoured when the forecast clears the strike by a floor
that depends on time to close — an empirical table in basis points of price,
times `DECIDED_FLOOR_MULTIPLIER`, and never below `DECIDED_SD_MULTIPLE` model
standard deviations. Basis points so it carries across price levels; the sd
term so volatile regimes demand more.

| seconds to close | calibrated floor (bp) | at 0.4× |
|---|---|---|
| < 15 | 1.3 | 0.5 |
| 15–30 | 2.6 | 1.0 |
| 30–60 | 6.5 | 2.6 |
| 60–120 | 19.5 | 7.8 |
| 120–300 | 32.5 | 13.0 |
| > 300 | never | never |

**Live market.** No entry unless the market's CLOB has printed a real fill in
the last 120 seconds. Every fill the simulator ever took at a "stale" price was
on a market Polymarket had stopped matching during a declared incident; those
fills could not have happened. This one rule blocked 100% of such windows in
the history and under 2% of healthy ones.

**Entry.** From 300 seconds before close down to 5, on every settlement tick,
buy the favoured side if its executable ask sits within `[0.15, 0.85]`. One
trade per window. The order is held for Polymarket's 50 ms taker delay and
matched against the book as it stands after the hold.

**Exit.** A stop fires when the executable bid falls to 65% of the entry price;
otherwise the position rides to oracle resolution. The stop is always on and
cannot be disabled. The trigger only decides *when* to sell: the order is
matched against whatever the bid side actually holds, walked to the bottom of
the book with no limit, so a collapsed book produces a near-total loss. A book
too thin to absorb the whole position leaves a remainder, which stays open with
the trigger re-armed.

**Execution.** Simulated FAK taker orders walk the real book level by level, so
fills reflect actual depth, partial fills, slippage and fees. The taker fee is
Polymarket's published crypto schedule, `shares × 0.07 × p × (1−p)`.

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
cleanup: which side became favoured and when, how many seconds it stayed so,
the cheapest ask the book offered on that side meanwhile, and the last reason
the engine gave for not trading — including `market_stale`. Untraded windows
are the baseline for whether the price cap and floor sit where the
opportunities are.

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
