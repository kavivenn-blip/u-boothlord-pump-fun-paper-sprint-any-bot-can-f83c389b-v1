// Dip Rider — pump.fun paper-trading bot for make.fun
// (u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b, pumpfun-replay/v2)
//
// Idea, in one line: buy a proven runner only after it pulls back, sell the
// bounce, cut the loss fast, never chase a spike.
//
// Why this shape (from the dev-window data in the kit, 24h, 1222 coins):
//   - Every coin's price ends back near its creation price (median last
//     return 1.00x): the money is in the waves, not in holding. A coin that
//     ran >= 2x and then pulled back >= 25% has shown both demand and a
//     cheaper re-entry; buying the spike itself pays a 2-slot latency tax
//     (fills land after the spike, median +2.6%, p90 +47.5% above the
//     decision price), so momentum-chasing was tested and rejected:
//     grade-local -4.16 SOL, win rate 11%.
//   - A round trip costs ~2.5% in curve fees plus 210,000 lamports of tx
//     fees, so a trade needs > ~3% of price move just to break even. The
//     take-profit (+40%) is ~13x that cost and the stop-loss (-20%) ~7x.
//   - The house's own pilots lose on this window too (momentum -9.45 SOL,
//     reversion -4.37, sniper -0.42), and no rule family we tested
//     (momentum, velocity, slow, pyramid, tight trail, slippage-limited,
//     hold-to-completion) is profitable on dev. This candidate does not
//     pretend otherwise: it is the least-bad robust rule we found, with a
//     small drawdown and guardrails met with margin.
//
// Risk controls, all explicit in this file:
//   - MAX_POSITIONS = 5 (harness cap), one round trip per coin, never short.
//   - TAKE_PROFIT_BPS = 4000 (+40% vs volume-weighted fill basis, all out).
//   - STOP_LOSS_BPS = 2000 (-20% vs fill basis).
//   - TIME_STOP_SLOTS = 7200 (~48 min): flat positions are closed so the
//     capital can cycle to the next coin.
//   - TARGET_BUY = 0.08 SOL, MIN_BUY = 0.015 SOL (guardrail needs round
//     trips >= 0.01 SOL; 0.015 leaves margin for fees/slippage).
//   - MAX_SLIPPAGE_BPS = 500 on every order; a sell is never sent twice
//     while one is still pending.
//
// Determinism: no clock, no Math.random, no environment, no network. Every
// decision is a pure function of the harness state; iteration follows
// first-seen order, which is fixed for a given dataset. Two runs on the same
// data produce the same action log byte for byte.
//
// hello, batch, orders, slot: the harness speaks agent-fun/replay/v2; the
// shim in ./vendor/makefun-bot.ts owns the wire (see the kit's SDK).

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning
// Seven tuned numbers, set from the dev-window analysis + fee arithmetic,
// NOT by grid-searching the dev score (see notes/jalur-produksi.md).
const TARGET_BUY_LAMPORTS = 80_000_000n; // 0.08 SOL per buy
const MIN_BUY_LAMPORTS = 15_000_000n; // 0.015 SOL; guardrail needs >= 0.01 SOL
const MAX_POSITIONS = 5;
const MIN_PEAK_BPS = 10000; // entry needs a running peak >= +100% over creation
const DIP_BPS = 2500; // ...and a pullback of >= 25% from that peak
const TAKE_PROFIT_BPS = 4000; // sell all at +40% vs fill basis
const STOP_LOSS_BPS = 2000; // sell all at -20% vs fill basis
const TIME_STOP_SLOTS = 7200; // ~48 min of slots held with no exit
const MAX_SLIPPAGE_BPS = 500;

// ------------------------------------------------------------- price ratios
// A price is virtual_quote_reserves / virtual_token_reserves (SOL/token).
// All comparisons use BigInt cross-multiplication, so there is no float
// rounding anywhere in a decision.
function priceGte(priceNum: bigint, priceDen: bigint, refNum: bigint, refDen: bigint, bps: number): boolean {
  // price/ref >= (10000 + bps) / 10000 ?
  return priceNum * refDen * 10_000n >= refNum * priceDen * BigInt(10_000 + bps);
}

function priceLte(priceNum: bigint, priceDen: bigint, refNum: bigint, refDen: bigint, bps: number): boolean {
  // price/ref <= (10000 - bps) / 10000 ?
  return priceNum * refDen * 10_000n <= refNum * priceDen * BigInt(10_000 - bps);
}

// ------------------------------------------------------------------- track
interface CoinTrack {
  mint: string;
  refNum: bigint; // reference price numerator (creation price, else first seen)
  refDen: bigint; // reference price denominator
  peakNum: bigint; // highest price numerator seen since creation
  peakDen: bigint; // highest price denominator seen since creation
  entered: boolean; // this bot has bought this coin (one round trip max)
  enteredSlot: number; // slot of the buy decision, -1 until entered
  done: boolean; // exited (or completed): never trade this coin again
}

const tracks = new Map<string, CoinTrack>();

// Counters for the end-of-run stderr summary (diagnostics only).
let buysSent = 0;
let sellsSent = 0;

function trackFor(mint: string, priceNum: bigint, priceDen: bigint): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      mint,
      refNum: priceNum,
      refDen: priceDen,
      peakNum: priceNum,
      peakDen: priceDen,
      entered: false,
      enteredSlot: -1,
      done: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: OrderInput[] = [];
    // Positions this batch's own orders will open (state does not know
    // them yet): enforce the 5-position cap locally so we never send a
    // buy the harness must reject.
    let buysPushedThisBatch = 0;

    // ---- 1. Fold this batch's events into per-coin tracks, and remember
    // which coins traded in this batch. Only those are touched below, so
    // the per-batch work stays O(events this batch + open positions).
    const tradedThisBatch = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = trackFor(
          e.mint,
          BigInt(e.virtual_quote_reserves),
          BigInt(e.virtual_token_reserves),
        );
        // Creation is the reference price whenever we see it.
        t.refNum = BigInt(e.virtual_quote_reserves);
        t.refDen = BigInt(e.virtual_token_reserves);
        t.peakNum = t.refNum;
        t.peakDen = t.refDen;
      } else if (e.event === 'TradeEvent') {
        const curve = state.curves.get(e.mint);
        if (curve === undefined) continue;
        const t = trackFor(e.mint, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const pn = curve.virtual_quote_reserves;
        const pd = curve.virtual_token_reserves;
        if (pn * t.peakDen > t.peakNum * pd) {
          t.peakNum = pn;
          t.peakDen = pd;
        }
        tradedThisBatch.add(e.mint);
      } else {
        // CompleteEvent: the curve is over; the harness closes positions
        // itself. Mark done so we never try to re-enter it.
        const t = tracks.get(e.mint);
        if (t !== undefined) t.done = true;
      }
    }

    // ---- 2. Exits first: for every held position, check take-profit,
    // stop-loss and time stop against the latest mark price. A sell is
    // never sent twice while one is still pending for that mint.
    for (const [mint, holding] of state.positions) {
      const t = tracks.get(mint);
      const curve = state.curves.get(mint);
      if (t === undefined || curve === undefined) continue;
      if (holding.token_amount <= 0n || holding.cost_lamports <= 0n) continue;
      const hasPendingSell = [...state.pending.values()].some(
        (p) => p.order.side === 'sell' && p.order.mint === mint,
      );
      if (hasPendingSell) continue;
      const priceNum = curve.virtual_quote_reserves;
      const priceDen = curve.virtual_token_reserves;
      const basisNum = holding.cost_lamports;
      const basisDen = holding.token_amount;
      const tpHit = priceGte(priceNum, priceDen, basisNum, basisDen, TAKE_PROFIT_BPS);
      const stopHit = priceLte(priceNum, priceDen, basisNum, basisDen, STOP_LOSS_BPS);
      const timeHit = t.enteredSlot >= 0 && state.slot - t.enteredSlot > TIME_STOP_SLOTS;
      if (tpHit || stopHit || timeHit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        sellsSent += 1;
        t.done = true;
      }
    }

    // ---- 3. Entries: only for coins that traded in this batch, only once
    // per coin. A coin qualifies when its running peak reached >= +100%
    // over its creation price and the current price has pulled back >= 25%
    // from that peak. The reserve cap must allow a guardrail-sized buy.
    if (state.committedPositionCount() + buysPushedThisBatch < MAX_POSITIONS) {
      for (const mint of tradedThisBatch) {
        const t = tracks.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined) continue;
        if (t.done || t.entered || curve.complete) continue;
        const priceNum = curve.virtual_quote_reserves;
        const priceDen = curve.virtual_token_reserves;
        // Peak must have reached +100% over the creation price...
        if (!priceGte(t.peakNum, t.peakDen, t.refNum, t.refDen, MIN_PEAK_BPS)) continue;
        // ...and the price must have pulled back >= 25% from that peak.
        if (!priceLte(priceNum, priceDen, t.peakNum, t.peakDen, DIP_BPS)) continue;
        const hasPendingBuy = [...state.pending.values()].some(
          (p) => p.order.side === 'buy' && p.order.mint === mint,
        );
        if (hasPendingBuy) continue;
        const cap = state.maxBuyLamports(mint);
        const size = cap < TARGET_BUY_LAMPORTS ? cap : TARGET_BUY_LAMPORTS;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (state.freeCashLamports() < size + 1_000_000n) continue;
        if (state.committedPositionCount() + buysPushedThisBatch >= MAX_POSITIONS) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        buysSent += 1;
        buysPushedThisBatch += 1;
        t.entered = true;
        t.enteredSlot = state.slot;
      }
    }

    return orders;
  },

  onDone(state: BotState) {
    // Diagnostics go to stderr; stdout carries replies only.
    const cash = state.cash;
    const pnl = cash - 10_000_000_000n;
    console.error(
      `done: cash=${cash} pnl_lamports=${pnl} buys=${buysSent} sells=${sellsSent} ` +
        `coins_seen=${tracks.size} positions_left=${state.positions.size}`,
    );
  },
});
