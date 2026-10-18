/**
 * 1-minute candles [[Date, open, high, low, close, volume], ...] from ticks
 * (LTP and cumulative day volume), e.g. to run the candle backtest on the
 * simulated morning or a recorded day. Only ticks with an exchange time are used.
 */
export function ticksToCandles(ticks) {
  const byMinute = new Map();
  let lastVolume = null;
  for (const t of [...ticks].filter((x) => x.exchangeTime && x.ltp > 0).sort((a, b) => a.exchangeTime - b.exchangeTime)) {
    const minute = Math.floor(t.exchangeTime / 60_000) * 60_000;
    let c = byMinute.get(minute);
    if (!c) { c = [new Date(minute), t.ltp, t.ltp, t.ltp, t.ltp, 0]; byMinute.set(minute, c); }
    c[2] = Math.max(c[2], t.ltp);
    c[3] = Math.min(c[3], t.ltp);
    c[4] = t.ltp;
    if (t.volume != null) {
      if (lastVolume != null && t.volume > lastVolume) c[5] += t.volume - lastVolume;
      lastVolume = t.volume;
    }
  }
  return [...byMinute.values()];
}
