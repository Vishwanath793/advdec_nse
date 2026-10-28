/**
 * 9:15 gap-plan inputs for a stock outside today's opening universe, for example one opted in to
 * live gap exits after the 09:10 preparation. The 09:10 pre-open row gives the previous close,
 * the opening price and the circuit; Kite gives the ATR(14), the previous day's high/low, the
 * tick and the lot, fetched for this stock (cached for the day by the history service). Without
 * a Kite session, or if Kite fails, the ATR stays an estimate and says why.
 */
export function createGapFallback({ preopenStocks, instruments, history, session }) {
  return async function gapFallback(symbol, side) {
    const s = (await preopenStocks())?.stocks.find((x) => x.symbol === symbol);
    if (!s) return null;
    let atr = null;
    let prevDay = null;
    let tick = null;
    let lot = 1;
    let why = null;
    const sess = session();
    if (sess?.accessToken) {
      try {
        const e = (await instruments.load(sess)).equity(symbol);
        if (e) {
          tick = e.tick ?? null;
          lot = e.lot ?? 1;
          const { history: h } = await history.load([{ symbol, token: e.token }], sess);
          atr = h[symbol]?.atr14 ?? null;
          prevDay = h[symbol]?.prevDay ?? null;
          if (!atr) why = 'Kite returned too few daily candles';
        } else why = 'not in Kite\'s instruments';
      } catch (error) { why = `Kite: ${error.message}`; }
    } else why = 'no Kite session';
    return {
      symbol, side, prevClose: s.prevClose, open: s.finalPrice, atr, tick, lot,
      upperCircuit: s.upperCircuit ?? null, lowerCircuit: s.lowerCircuit ?? null,
      prevHigh: prevDay?.high ?? s.prevHigh ?? null, prevLow: prevDay?.low ?? s.prevLow ?? null,
      sources: {
        prevClose: 'NSE pre-open (09:10 import)', open: 'NSE pre-open final price (09:10 import)',
        atr: atr ? 'ATR(14) from Kite daily candles (fetched for this stock)' : `missing (${why}): estimated`,
        tick: tick ? 'Kite instruments' : 'default ₹0.05', circuit: 'NSE price bands',
        prevHigh: prevDay ? `Kite daily candle of ${prevDay.date}` : '09:10 analyzer data (Kite daily candle missing)',
      },
    };
  };
}
