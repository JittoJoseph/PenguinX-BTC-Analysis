# Strategic Market Engine

[![Live Demo](https://img.shields.io/badge/Live_Demo-strategic--market--engine.vercel.app-007acc)](https://strategic-market-engine.vercel.app/)

[![Backend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=backend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Frontend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=frontend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Health Check](https://img.shields.io/website?url=https://market-api.jittojoseph.xyz/ping&label=health)](https://market-api.jittojoseph.xyz/ping)

Volatility-barrier trading on Polymarket BTC 5-minute Up/Down markets. In the
final seconds before a window closes, the outcome (Chainlink end-vs-open) is
often near-certain yet the thin order book still prices the favorite at ~0.97.
The engine enters only when the favorite is far enough from the strike in
**volatility-adjusted** terms to make a reversal statistically negligible.

## Architecture

- **Backend**: Node.js/TypeScript service with PostgreSQL (Supabase) database
- **Frontend**: Next.js dashboard with real-time WebSocket updates
- **Strategy**: Volatility-barrier (first-passage z-score) on BTC 5m Up/Down markets

## Strategy

For the current favorite, compute `z = signedDistance / (sigma · sqrt(secondsLeft))`,
where `signedDistance` is BTC's distance from the window-open strike in the
favorite's direction and `sigma` is BTC's live realized per-second volatility
(std of 1s returns over a trailing window). Enter only when `z ≥ Z*` (default
3.0) during the final `entryFromWindowSeconds` (default 30s), paying no more than
`maxEntryPrice`. Exit early only if BTC actually crosses back through the strike
(a real reversal), never on order-book price noise; otherwise hold to oracle
resolution. All parameters are environment-tunable — see `backend/.env.example`.

## Features

- Real-time BTC price + volatility monitoring via Chainlink RTDS WebSocket
- Automated market scanning and volatility-barrier opportunity detection
- Depth-aware simulated FAK execution with position management
- BTC-recross early exit; consecutive-loss risk guard
- Live dashboard with portfolio tracking and P&L visualization
