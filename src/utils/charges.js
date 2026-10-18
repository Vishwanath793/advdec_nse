/**
 * Zerodha charges for NSE equity intraday (MIS), in one place because they change.
 * Source: https://zerodha.com/charges (Equity intraday), checked 18 Oct 2026:
 *   brokerage 0.03% or ₹20 per executed order, whichever is lower;
 *   STT 0.025% on the sell side; NSE transaction charges 0.00307%;
 *   SEBI ₹10 per crore; stamp duty 0.003% on the buy side;
 *   GST 18% on brokerage + transaction charges + SEBI charges.
 *   Orders squared off by Zerodha (call & trade, incl. auto square-off) cost ₹50 extra.
 * Update RATES (and the date) when Zerodha's page changes.
 */
export const INTRADAY_EQUITY_RATES = {
  checked: '2026-10-18',
  source: 'https://zerodha.com/charges',
  brokeragePct: 0.03,
  brokerageCapPerOrder: 20,
  sttSellPct: 0.025,
  exchangePct: 0.00307,
  sebiPerCrore: 10,
  stampBuyPct: 0.003,
  gstPct: 18,
  autoSquareOffCharge: 50,
};

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Charges for executed orders: `orders` = [{ side: 'BUY'|'SELL', value }]
 * (value = price × quantity of each executed order). Returns the parts and the total (₹).
 */
export function intradayCharges(orders, rates = INTRADAY_EQUITY_RATES) {
  let brokerage = 0;
  let stt = 0;
  let exchange = 0;
  let stamp = 0;
  let turnover = 0;
  for (const o of orders) {
    const v = Math.max(0, Number(o.value) || 0);
    if (!v) continue;
    turnover += v;
    brokerage += Math.min((v * rates.brokeragePct) / 100, rates.brokerageCapPerOrder);
    exchange += (v * rates.exchangePct) / 100;
    if (o.side === 'SELL') stt += (v * rates.sttSellPct) / 100;
    if (o.side === 'BUY') stamp += (v * rates.stampBuyPct) / 100;
  }
  const sebi = (turnover * rates.sebiPerCrore) / 1e7;
  const gst = ((brokerage + exchange + sebi) * rates.gstPct) / 100;
  const parts = { brokerage, stt, exchange, sebi, stamp, gst };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r2(v)])), total: r2(total), turnover: r2(turnover) };
}

/** Estimated charges for a round trip of `qty` shares entered at `entry` and exited at `exit`. */
export function roundTripCharges({ side, qty, entry, exit, exitOrders = 1 }, rates = INTRADAY_EQUITY_RATES) {
  const entrySide = side === 'SELL' ? 'SELL' : 'BUY';
  const exitSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
  const parts = Array.from({ length: Math.max(1, exitOrders) }, () => ({ side: exitSide, value: (exit * qty) / Math.max(1, exitOrders) }));
  return intradayCharges([{ side: entrySide, value: entry * qty }, ...parts], rates);
}
