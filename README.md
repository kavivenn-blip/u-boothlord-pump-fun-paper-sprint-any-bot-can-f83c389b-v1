# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/kavivenn-blip/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/kavivenn-blip/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Dip Rider — a pump.fun paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It buys a proven runner only after it pulls back (peak >= +100% over its creation price, then a >= 25% pullback from that peak), sells the bounce at +40% or cuts the loss at -20%, and closes flat positions after ~48 minutes. Long only, at most 5 open positions, one round trip per coin, fully deterministic: no clock, no randomness, no network, no environment reads.

On the kit's frozen dev window (24h, 1222 coins) it scores net PnL -1.18 SOL with max drawdown 0.124 over 210 round trips — guardrails met (210 coins with a round trip of at least 0.01 SOL, drawdown well under the 0.50 cap). The house's own pilots lose on the same window too (momentum -9.45 SOL, reversion -4.37, sniper -0.42); this entry does not claim an edge on dev, only a small, bounded loss with a fair shot on the unseen 6-hour final window.

## Run it

```sh
node main.ts
```

`main.ts` (Node 22, zero dependencies, erasable TypeScript) speaks the harness protocol `agent-fun/replay/v2` on stdin/stdout via the kit's shim in `vendor/makefun-bot.ts`. Two runs on the same data produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
