import { indiaDate, marketDay } from './calendar.js';
import { tickSize } from '../utils/analysis.js';

/**
 * Time-triggered orders: "BUY 10 INFY at market at 09:15:00". Kite has no
 * time trigger (GTT triggers on price), so the order is held here and sent to
 * Kite at the chosen second. Runs in the backend (browser can be closed) and
 * on the phone (app must be open).
 *
 * Safety:
 *  - an order is sent at most once (scheduled -> placing -> placed/failed);
 *  - if the trigger was missed by more than ORDER_GRACE_MS (machine asleep,
 *    backend restarted), the order is marked "missed", never sent late;
 *  - the Kite access token is kept in memory only, never in the store.
 */

export const ORDER_GRACE_MS = 20_000;
export const MIN_LEAD_MS = 3_000;
export const MAX_AHEAD_DAYS = 7;
export const MAX_QUANTITY = 100_000;
/** Regular orders are accepted 09:00–15:30 IST (pre-open order entry ends at 09:08). */
export const ORDER_WINDOW = { start: '09:00', end: '15:30', preOpenEnd: '09:08', open: '09:15' };
const HISTORY_KEEP = 100;
const MAX_TIMER_MS = 2 ** 31 - 1;
const FILE = 'scheduled-orders.json';

const istTime = (date) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(date);

/**
 * Validate and normalise an order request. Returns { order, warnings } or
 * throws an Error with a message fit to show the user.
 */
export function validateScheduledOrder(input, now, calendar) {
  const warnings = [];
  const symbol = String(input?.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9&_-]{1,25}$/.test(symbol)) throw new Error('Enter a valid NSE symbol, like INFY.');
  const side = String(input?.side ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('Choose Buy or Sell.');
  const quantity = Number(input?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new Error(`Quantity must be a whole number from 1 to ${MAX_QUANTITY.toLocaleString('en-IN')}.`);
  }
  const orderType = String(input?.orderType ?? 'MARKET').toUpperCase();
  if (orderType !== 'MARKET' && orderType !== 'LIMIT') throw new Error('Order type must be Market or Limit.');
  let price = null;
  if (orderType === 'LIMIT') {
    const raw = Number(input?.price);
    if (!(raw > 0)) throw new Error('Enter a limit price.');
    const tick = tickSize(raw);
    price = Math.round(Math.round(raw / tick) * tick * 100) / 100;
    if (Math.abs(price - raw) > 1e-9) warnings.push(`Limit price rounded to the ₹${tick} tick: ₹${price}.`);
  }
  const product = String(input?.product ?? 'MIS').toUpperCase();
  if (!['MIS', 'CNC', 'NRML'].includes(product)) throw new Error('Product must be MIS, CNC or NRML.');
  const exchange = String(input?.exchange ?? 'NSE').toUpperCase();
  if (exchange !== 'NSE' && exchange !== 'BSE') throw new Error('Exchange must be NSE or BSE.');

  const triggerAt = new Date(input?.triggerAt);
  if (!Number.isFinite(+triggerAt)) throw new Error('Choose a valid date and time.');
  if (triggerAt - now < MIN_LEAD_MS) throw new Error('The time must be at least a few seconds in the future.');
  if (triggerAt - now > MAX_AHEAD_DAYS * 86_400_000) throw new Error(`Orders can be scheduled up to ${MAX_AHEAD_DAYS} days ahead.`);
  const day = indiaDate(triggerAt);
  const market = marketDay(day, calendar);
  if (!market.open) throw new Error(`${day} is not a trading day (${market.reason}).`);
  const time = istTime(triggerAt);
  if (time < `${ORDER_WINDOW.start}:00` || time > `${ORDER_WINDOW.end}:00`) {
    throw new Error(`Choose a time between ${ORDER_WINDOW.start} and ${ORDER_WINDOW.end} IST.`);
  }
  if (time >= `${ORDER_WINDOW.preOpenEnd}:00` && time < `${ORDER_WINDOW.open}:00`) {
    warnings.push(`Between ${ORDER_WINDOW.preOpenEnd} and ${ORDER_WINDOW.open} NSE accepts no new orders for most stocks; Kite may reject it. ${ORDER_WINDOW.open}:00 or later is safer.`);
  }
  if (product === 'MIS' && time >= '15:20:00') warnings.push('MIS positions are squared off from 15:20; a new MIS order then may be rejected.');

  const marketProtection = Number(input?.marketProtection ?? -1);
  return {
    order: {
      symbol, side, quantity, orderType, price, product, exchange,
      triggerAt: triggerAt.toISOString(),
      marketProtection: Number.isFinite(marketProtection) ? marketProtection : -1,
      autoslice: input?.autoslice !== false,
      tag: typeof input?.tag === 'string' ? input.tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) : '',
      note: typeof input?.note === 'string' ? input.note.slice(0, 200) : '',
    },
    warnings,
  };
}

/** Kite order form fields for a scheduled order. */
export function kiteOrderFor(o) {
  return {
    exchange: o.exchange,
    tradingsymbol: o.symbol,
    transaction_type: o.side,
    quantity: o.quantity,
    product: o.product,
    order_type: o.orderType,
    validity: 'DAY',
    variety: 'regular',
    ...(o.orderType === 'LIMIT' ? { price: o.price } : { market_protection: o.marketProtection, autoslice: o.autoslice }),
    ...(o.tag ? { tag: o.tag } : {}),
  };
}

/**
 * `placeOrder({ apiKey, accessToken, order })` is the Kite client's.
 * `store` is a JSON store; `onChange(list)` is told about every status change.
 */
export function createOrderScheduler({
  store, placeOrder, calendar, now = () => new Date(), onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let orders = [];
  let session = null; // { apiKey, accessToken, userId } — memory only
  const timers = new Map();
  let loaded = null;
  let nextId = 1;

  const save = () => store.write(FILE, { orders });
  const publish = () => { try { onChange(list()); } catch { /* listener errors don't matter */ } };

  /** Pending orders first (soonest first), then history (newest first). */
  function list() {
    const pending = (o) => o.status === 'scheduled' || o.status === 'placing';
    return [...orders].sort((a, b) => (pending(b) - pending(a))
      || (pending(a) ? a.triggerAt.localeCompare(b.triggerAt) : b.triggerAt.localeCompare(a.triggerAt)));
  }

  async function update(o, patch) {
    Object.assign(o, patch);
    // Keep all pending orders and the most recent history.
    const pending = orders.filter((x) => x.status === 'scheduled' || x.status === 'placing');
    const done = orders.filter((x) => !pending.includes(x)).sort((a, b) => b.triggerAt.localeCompare(a.triggerAt)).slice(0, HISTORY_KEEP);
    orders = [...pending, ...done];
    await save();
    publish();
  }

  function arm(o) {
    clearTimer(timers.get(o.id));
    if (o.status !== 'scheduled') return;
    const delay = new Date(o.triggerAt) - now();
    timers.set(o.id, setTimer(() => { fire(o.id).catch(() => {}); }, Math.max(0, Math.min(delay, MAX_TIMER_MS))));
  }

  async function fire(id) {
    const o = orders.find((x) => x.id === id);
    if (!o || o.status !== 'scheduled') return o;
    const t = now();
    const due = new Date(o.triggerAt);
    if (t < due - 20) { arm(o); return o; } // woke early (or a long wait in steps)
    if (t - due > ORDER_GRACE_MS) {
      await update(o, { status: 'missed', result: { error: `Not sent: the app wasn't running at ${istTime(due)} (checked ${Math.round((t - due) / 1000)} s later).` } });
      return o;
    }
    if (!session?.accessToken) {
      await update(o, { status: 'failed', result: { error: 'Kite was not connected at the trigger time. Log in to Kite in Settings.' } });
      return o;
    }
    await update(o, { status: 'placing', result: null });
    try {
      const response = await placeOrder({ apiKey: session.apiKey, accessToken: session.accessToken, order: kiteOrderFor(o) });
      const placedAt = now();
      await update(o, {
        status: 'placed',
        result: { orderId: response?.order_id ?? null, placedAt: placedAt.toISOString(), latencyMs: placedAt - due },
      });
    } catch (error) {
      await update(o, { status: 'failed', result: { error: error.message, at: now().toISOString() } });
    }
    return o;
  }

  async function load() {
    loaded ??= (async () => {
      orders = (await store.read(FILE))?.orders ?? [];
      nextId = orders.reduce((m, o) => Math.max(m, Number(String(o.id).replace(/\D/g, '')) || 0), 0) + 1;
      const t = now();
      for (const o of orders) {
        // Interrupted while sending: don't resend, the order may have reached Kite.
        if (o.status === 'placing') {
          Object.assign(o, { status: 'failed', result: { error: 'The app stopped while sending this order. Check the Kite order book before placing it again.' } });
        } else if (o.status === 'scheduled' && t - new Date(o.triggerAt) > ORDER_GRACE_MS) {
          Object.assign(o, { status: 'missed', result: { error: `Not sent: the app wasn't running at ${istTime(new Date(o.triggerAt))}.` } });
        }
      }
      await save();
      orders.forEach(arm);
    })();
    return loaded;
  }

  return {
    load,
    list: async () => { await load(); return list(); },
    /** Kite session for sending (memory only). Pass null to forget it. */
    setSession(s) {
      session = s?.accessToken && s?.apiKey ? { apiKey: s.apiKey, accessToken: s.accessToken, userId: s.userId ?? null } : null;
      return { connected: Boolean(session), userId: session?.userId ?? null };
    },
    sessionStatus: () => ({ connected: Boolean(session), userId: session?.userId ?? null }),
    async add(input) {
      await load();
      const { order, warnings } = validateScheduledOrder(input, now(), calendar);
      const duplicate = orders.find((o) => o.status === 'scheduled' && o.symbol === order.symbol && o.side === order.side
        && o.quantity === order.quantity && o.triggerAt === order.triggerAt && o.orderType === order.orderType && o.price === order.price);
      if (duplicate) throw new Error(`The same order is already scheduled (${duplicate.id}).`);
      const o = { id: `S${nextId++}`, ...order, createdAt: now().toISOString(), status: 'scheduled', result: null };
      orders.push(o);
      await save();
      arm(o);
      publish();
      return { order: o, warnings };
    },
    async cancel(id) {
      await load();
      const o = orders.find((x) => x.id === id);
      if (!o) throw new Error('No such scheduled order.');
      if (o.status !== 'scheduled') throw new Error(`It can't be cancelled: it is already ${o.status}.`);
      clearTimer(timers.get(id));
      timers.delete(id);
      await update(o, { status: 'cancelled', result: { at: now().toISOString() } });
      return o;
    },
    fire, // exposed for tests
    stop() { for (const t of timers.values()) clearTimer(t); timers.clear(); },
  };
}
