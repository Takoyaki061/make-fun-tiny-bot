// Tiny Bot: dip-buy mean reversion + rally rider, long only, mostly cash.
//
// Idea (tested on the dev window, hourly bars of 7 Solana assets):
//   - The dev window falls almost every day (-3% to -14% per asset), so buy-and-hold
//     loses ~$869 and trend/momentum baselines lose $170-$270. The edge is NOT being
//     invested: hourly prices overshoot down and bounce ~2% within a day, so buying a
//     sharp 24h dip and selling the bounce beats holding through the bleed.
//   - Dip arm: when a symbol's close is >5% below its close 24 bars ago, buy it.
//     Exit at +2% (take the bounce), -3% (the dip keeps dipping), or after 24 bars
//     (a dip that does not bounce within a day is a new trend, not noise).
//   - Rally arm (insurance for an up final window, where dip-only would sit in cash
//     while buy-and-hold gains): when a symbol's 24h return tops +3% and it is one of
//     the top 3 by 24h return, buy it and ride it until its 24h return turns negative,
//     its EMA(8) falls under EMA(21), or a -3% stop. In the down dev window this arm
//     barely fires, so it costs little there.
//   - Sizing: each buy spends min(cash / 4, 25% of equity) -- the weight cap -- so at
//     most a few positions are open at once and a -3% stop costs at most ~$75 a trade.
//     Fees are 10 bps a side and pool impact on a $2,500 trade is only ~3-15 bps.
//   - Deterministic: no clock, no randomness, no network; every decision is a pure
//     function of the bars seen so far. History is built during warm-up too.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const LOOKBACK = 24; // bars in a day (1h bars)
const DIP_ENTRY = -0.05; // 24h return below this: buy the dip
const DIP_TAKE = 0.02; // dip exit: +2% from entry close
const DIP_STOP = -0.03; // dip exit: -3% from entry close
const DIP_MAX_HOLD = 24; // dip exit: 24 bars without a bounce
const RALLY_ENTRY = 0.03; // 24h return above this, top 3: ride the rally
const RALLY_STOP = -0.03; // rally exit: -3% from entry close
const RALLY_TOP_N = 3;
const MAX_SLIPPAGE_BPS = 100; // 1% past the decision close; a gapped fill is retried next bar
const SIZE_DIVISOR = 4n; // each buy spends at most cash / 4 (and the 25% weight cap)

interface Entry {
  tag: 'dip' | 'mom';
  entryClose: number; // close on the bar the buy was decided on
  entrySeq: number; // batch seq of that decision
}

const closes = new Map<string, number[]>(); // per-symbol closes, in batch order
const entries = new Map<string, Entry>(); // symbols we hold (or just bought), with entry facts
const emaFast = new Map<string, number | null>(); // EMA(8), seeded as the mean of its first 8 closes
const emaSlow = new Map<string, number | null>(); // EMA(21)
const emaWarmFast = new Map<string, number[]>();
const emaWarmSlow = new Map<string, number[]>();

function emaStep(span: number, warm: number[], value: number | null, close: number): number | null {
  if (value !== null) return value + (2 / (span + 1)) * (close - value);
  warm.push(close);
  if (warm.length === span) return warm.reduce((a, x) => a + x, 0) / span;
  return null;
}

/** 24h return of a symbol as of the latest close, or null without 24 bars of history. */
function ret24(symbol: string): number | null {
  const h = closes.get(symbol);
  if (h === undefined || h.length <= LOOKBACK) return null;
  const now = h[h.length - 1];
  const then = h[h.length - 1 - LOOKBACK];
  return now / then - 1;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Fold this batch's bars into history and EMAs (warm-up bars included).
    // NOTE (revision after first local grade): the warm-up arrays must be created in
    // the maps BEFORE emaStep runs, or the first bar's push is lost into a temp array
    // and both EMAs seed one bar late.
    for (const bar of batch.bars) {
      const c = Number(bar.c);
      const h = closes.get(bar.symbol) ?? [];
      h.push(c);
      closes.set(bar.symbol, h);
      if (!emaWarmFast.has(bar.symbol)) emaWarmFast.set(bar.symbol, []);
      if (!emaWarmSlow.has(bar.symbol)) emaWarmSlow.set(bar.symbol, []);
      emaFast.set(bar.symbol, emaStep(8, emaWarmFast.get(bar.symbol)!, emaFast.get(bar.symbol) ?? null, c));
      emaSlow.set(bar.symbol, emaStep(21, emaWarmSlow.get(bar.symbol)!, emaSlow.get(bar.symbol) ?? null, c));
    }
    if (state.warmingUp) return [];

    // Drop entry records for positions that are gone (a buy the market refused, or a sell filled).
    for (const symbol of [...entries.keys()]) {
      if (!state.positions.has(symbol)) entries.delete(symbol);
    }

    const { caps, fees } = state.hello;
    const orders: OrderInput[] = [];
    const sells: SellInput[] = [];

    // --- exits: decide from the latest close against the recorded entry close ---
    for (const [symbol, held] of state.positions) {
      const close = state.close(symbol);
      if (close === null) continue;
      const entry = entries.get(symbol);
      if (entry === undefined) continue; // a position with no entry record: hold it
      const move = Number(close) / entry.entryClose - 1;
      let exit = false;
      if (entry.tag === 'dip') {
        exit = move >= DIP_TAKE || move <= DIP_STOP || batch.seq - entry.entrySeq >= DIP_MAX_HOLD;
      } else {
        const r24 = ret24(symbol);
        const fast = emaFast.get(symbol) ?? null;
        const slow = emaSlow.get(symbol) ?? null;
        exit = move <= RALLY_STOP || (r24 !== null && r24 < 0) || (fast !== null && slow !== null && fast < slow);
      }
      if (exit) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        // NOTE (revision after first local grade): do NOT delete the entry record
        // here. If the market refuses this sell (e.g. slippage), the position is
        // still held next batch and the exit must be retried; the prune loop above
        // removes the record once the position is actually gone.
      }
    }
    orders.push(...sells.slice(0, caps.max_orders_per_bar));

    // --- entries: dip buys, plus top-3 rally buys ---
    const ranked = state.hello.symbols
      .map((s) => s.symbol)
      .map((symbol) => ({ symbol, r24: ret24(symbol) }))
      .filter((x): x is { symbol: string; r24: number } => x.r24 !== null)
      .sort((a, b) => b.r24 - a.r24);
    const rallySet = new Set(ranked.slice(0, RALLY_TOP_N).filter((x) => x.r24 > RALLY_ENTRY).map((x) => x.symbol));

    const maxPositions = Math.min(state.hello.symbols.length, caps.max_open_positions);
    let room = maxPositions - state.positions.size;
    let cash = state.cash;
    for (const { symbol, r24 } of ranked) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      if (state.positions.has(symbol) || state.close(symbol) === null) continue;
      const isDip = r24 < DIP_ENTRY;
      const isRally = rallySet.has(symbol);
      if (!isDip && !isRally) continue;
      // A symbol is either a dip or a rally buy, never both: the deeper signal wins.
      const tag: 'dip' | 'mom' = isDip ? 'dip' : 'mom';
      let slice = cash / SIZE_DIVISOR;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      if (slice > byWeight) slice = byWeight;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      entries.set(symbol, { tag, entryClose: Number(state.close(symbol)), entrySeq: batch.seq });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
