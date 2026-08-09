# Strategic Market Engine

[![Live Demo](https://img.shields.io/badge/Live_Demo-strategic--market--engine.vercel.app-007acc)](https://strategic-market-engine.vercel.app/)

[![Backend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=backend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Frontend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=frontend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Health Check](https://img.shields.io/website?url=https://market-api.jittojoseph.xyz/ping&label=health)](https://market-api.jittojoseph.xyz/ping)

A paper-trading simulator for Polymarket's BTC 5-minute Up/Down markets. It
watches live markets, applies a volatility-barrier entry rule, simulates fills
against the real order book, and records one row of market data per completed
window for later analysis.

No real money is traded.

## How it works

Markets are discovered by deterministic slug (`btc-updown-5m-<windowStart>`) and
subscribed to over the CLOB WebSocket. BTC comes from Polymarket's RTDS feed —
the **Chainlink BTC/USD 30-second TWAP**, which is what these markets settle on.

**Entry.** In the final 30 seconds of a window, for whichever side BTC currently
favours, compute

```
z = signedDistance / (sigma · sqrt(secondsLeft))
```

where `signedDistance` is BTC's distance from the window-open price in that
side's direction and `sigma` is live realized per-second volatility. Enter when
`z ≥ 3.0` and the executable ask sits within `[0.60, 0.98]`.

**Exit.** Market-sell if the executable bid falls 20¢ below entry; otherwise hold
to oracle resolution.

**Execution.** Simulated FAK taker orders walk the real ask side level by level,
so fills reflect actual depth, partial fills, slippage and fees. Exits apply a
250 ms submit-to-match latency and match against the book as it stands when the
order lands — the trigger price is not the fill price.

All parameters are environment-tunable; see [`backend/.env.example`](backend/.env.example).

## Simulation settings

These exist to keep the research sample unbiased and are **not** intended for a
real-money system:

- Every entry uses a fixed **$5** budget regardless of portfolio value.
- Trades are never skipped for lack of cash; the simulated balance may go
  negative.
- There is no consecutive-loss auto-pause.

Note that the simulated taker fee is an approximation and understates
Polymarket's published crypto fee, so reported PnL is optimistic.

## Data collection

Every completed window is recorded to `market_regime_data` — traded or not —
with BTC start/end/high/low, realized volatility, how many times BTC crossed the
start price, observation count, and whether we traded and won. The market's
actual Up/Down resolution is filled in asynchronously from Polymarket's API.

This is collection only: raw scalars, no regime labels or conclusions.

See [docs/market-regime-data.md](docs/market-regime-data.md).

## Architecture

| Component   | Stack                                                      |
| ----------- | ---------------------------------------------------------- |
| Backend     | Node.js 22+, TypeScript, PostgreSQL (Supabase) via Drizzle |
| Frontend    | Next.js dashboard, live updates over WebSocket             |
| Market data | Polymarket Gamma API, CLOB WebSocket, RTDS price feed      |

Backend services are single-purpose and wired through one orchestrator: market
scanner, CLOB book watcher, BTC price watcher, strategy engine, execution
simulator, portfolio manager, market recorder, API server.

Window boundaries and entry deadlines are defined by Polymarket, so the engine
runs on a market clock synced to the CLOB server rather than the host clock.
