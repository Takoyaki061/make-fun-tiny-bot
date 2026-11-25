# Tiny Bot — Dip-Buy Mean Reversion + Rally Rider

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Takoyaki061/make-fun-tiny-bot/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Takoyaki061/make-fun-tiny-bot/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1). It speaks the `agent-fun/bars-replay/v1` line protocol on stdin/stdout (via the vendored SDK in `vendor/`), trades the 7 hourly Solana assets long-only, and is usually in cash.

## Strategy

- **Dip arm (the edge):** when a symbol's close is more than 5% below its close 24 bars ago, buy it. Exit at +2% (take the bounce), −3% (the dip keeps dipping), or after 24 bars (a dip that does not bounce within a day is a new trend, not noise). Hourly prices overshoot down and bounce ~2% within a day, so buying sharp dips and selling the bounce beats holding through the bleed.
- **Rally arm (insurance for an up window):** when a symbol's 24h return tops +3% and it is one of the top 3 by 24h return, buy it and ride it until its 24h return turns negative, its EMA(8) falls under EMA(21), or a −3% stop. In a down window this arm barely fires.
- **Sizing:** each buy spends min(cash / 4, 25% of equity) — the weight cap — so a −3% stop costs at most ~$75 a trade. Slippage capped at 1% past the decision close; a refused fill is retried next bar.
- **Deterministic:** no clock, no randomness, no network, no outside files; every decision is a pure function of the bars seen so far.

## Dev-window results (grade-local, process driver)

| Bot | Net PnL (USDC) | Trades | Max drawdown |
| --- | --- | --- | --- |
| **Tiny Bot (this entry)** | **+314.36** | 47 | 1.94% |
| hold-cash | 0.00 | 0 | 0.00% |
| ema-cross | −173.04 | 28 | 2.51% |
| momentum | −268.23 | 19 | 5.66% |
| buy-and-hold | −869.34 | 7 | 10.92% |

Guardrails met (≥8 trades, drawdown ≤25%). At 2x fees the bot still nets +$256.39. The dip core was positive in both halves of the dev window in offline testing, and the −5% / −4% / −6% dip thresholds all score +$282 to +$314 on the grader, so the result is not a knife-edge fit.

## Layout

- `main.ts` — the bot (entrypoint, runs on Node 22.18+ as `node main.ts`)
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK, vendored byte-identical
- `README.md`, `LICENSE` (MIT)
