/**
 * LIVE order helpers (pure). Order bodies follow Kite Connect v3
 * (https://kite.trade/docs/connect/v3/orders/): POST /orders/regular with
 * exchange, tradingsymbol, transaction_type, quantity, product, order_type
 * (MARKET, LIMIT, SL, SL-M), price, trigger_price, validity (DAY, IOC),
 * market_protection (-1 automatic, for MARKET and SL-M) and tag (alphanumeric,
 * at most 20 characters).
 *
 * Roles, per position:
 *   entry   SL (stop-limit: trigger, limit = maximum entry) for breakouts, the same
 *           as the paper fill rule; LIMIT at the maximum entry for immediate entries.
 *   stop    SL-M with automatic market protection, resting at Kite for the filled
 *           quantity, so the position is protected even if this app stops.
 *   target  LIMIT IOC at the target, sent when the touch reaches it.
 *   exit    MARKET with automatic market protection (square-off, kill switch).
 * Placing an order never means it executed; fills come from Kite's order book.
 */

export const LIVE_ROLES = { entry: 'E', stop: 'S', target: 'T', exit: 'X' };
export const FINAL_STATUSES = ['COMPLETE', 'REJECTED', 'CANCELLED'];
export const OPEN_STATUSES = ['OPEN', 'TRIGGER PENDING'];

/** The text typed each day to arm LIVE trading. */
export const liveConfirmText = (date) => `LIVE ${date}`;

/**
 * A unique, Kite-valid tag for one order: L + day of month + role + sequence + symbol,
 * alphanumeric, at most 20 characters. Used to find the order after an unknown outcome.
 */
export function liveTag(date, symbol, role, seq) {
  const day = String(date).slice(8, 10);
  const sym = String(symbol).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return `L${day}${LIVE_ROLES[role] ?? 'O'}${seq}${sym}`.slice(0, 20);
}

const opposite = (side) => (side === 'BUY' ? 'SELL' : 'BUY');
const base = (symbol, side, qty, tag) => ({ variety: 'regular', exchange: 'NSE', tradingsymbol: symbol, transaction_type: side, quantity: qty, product: 'MIS', tag });

export function entryOrderBody(pos, tag) {
  const b = base(pos.symbol, pos.side, pos.qty, tag);
  return pos.immediate
    ? { ...b, order_type: 'LIMIT', price: pos.maxEntry, validity: 'DAY' }
    : { ...b, order_type: 'SL', trigger_price: pos.trigger, price: pos.maxEntry, validity: 'DAY' };
}

export const stopOrderBody = (pos, qty, trigger, tag) => ({
  ...base(pos.symbol, opposite(pos.side), qty, tag), order_type: 'SL-M', trigger_price: trigger, market_protection: -1, validity: 'DAY',
});

export const targetOrderBody = (pos, qty, price, tag) => ({
  ...base(pos.symbol, opposite(pos.side), qty, tag), order_type: 'LIMIT', price, validity: 'IOC',
});

export const exitOrderBody = (pos, qty, tag) => ({
  ...base(pos.symbol, opposite(pos.side), qty, tag), order_type: 'MARKET', market_protection: -1, validity: 'DAY',
});

/** Kite order-book row → the fields this app uses. */
export function readKiteOrder(o) {
  const status = String(o?.status ?? '').toUpperCase();
  return {
    orderId: o?.order_id ?? null, tag: o?.tag ?? null, status,
    filled: Number(o?.filled_quantity) || 0, pending: Number(o?.pending_quantity) || 0, cancelled: Number(o?.cancelled_quantity) || 0,
    avgPrice: Number(o?.average_price) || null, message: o?.status_message ?? null,
    final: FINAL_STATUSES.includes(status), open: !FINAL_STATUSES.includes(status),
  };
}

/** How a failed order request ended: 'unknown' (never resend blindly), 'ip', 'session', 'rate' or 'rejected'. */
export function classifyOrderError(error) {
  if (error?.unknown) return 'unknown';
  if (/not allowed to place orders|static ip|allowed ips/i.test(String(error?.message ?? ''))) return 'ip';
  if (error?.status === 403 || error?.data?.error_type === 'TokenException') return 'session';
  if (error?.status === 429) return 'rate';
  return 'rejected';
}

export const roundToTick = (price, tick = 0.05, dir = 0) => {
  const n = price / tick;
  const r = dir > 0 ? Math.ceil(n - 1e-9) : dir < 0 ? Math.floor(n + 1e-9) : Math.round(n);
  return Math.round(r * tick * 100) / 100;
};
