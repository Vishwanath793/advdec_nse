import { indiaDate, istInstant, marketDay } from './calendar.js';
import { tickSize } from '../utils/analysis.js';
import { liveTag } from '../utils/liveOrders.js';

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
/** Kite allows 10 order requests a second: orders due together go out this far apart. */
export const SEND_SPACING_MS = 120;
/** Wait before the single retry of an order Kite refused for speed (HTTP 429). */
export const RATE_RETRY_MS = 1_000;
/**
 * The scheduler arms an order this long before its time: it checks the Kite
 * session, saves "placing" (so a crash can never send it twice) and opens the
 * connection to Kite, then the sender waits for the exact millisecond. At 09:15:00
 * the backend is busy with the opening's tick flood (21 Oct 2026: an order left
 * 523 ms late, against 4 ms at 10:15), so the backend's sender runs in a worker thread.
 */
export const PREARM_MS = 2_000;
/** The worker sleeps until this close to the time, then checks the clock continuously. */
export const SPIN_MS = 15;
/** Kite's own record of a placed order is read this long after placing (until it is final). */
export const KITE_CHECK_MS = [5_000, 30_000, 120_000];
const FINAL_STATUSES = ['COMPLETE', 'REJECTED', 'CANCELLED'];
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
  // LIVE gap exits (the 9:15 gap entry, phase 2): only a 09:15 MARKET MIS order on NSE.
  const exits = input?.exits === 'gap' ? 'gap' : null;
  if (exits) {
    if (orderType !== 'MARKET' || product !== 'MIS' || exchange !== 'NSE' || time < '09:15:00' || time >= '09:16:00') {
      throw new Error('Live gap exits need a MARKET, MIS, NSE order sent between 09:15:00 and 09:15:59.');
    }
    warnings.push('Live gap exits: real stop and target orders follow this order at Kite. It is sent only if live exits are armed that day (Settings switch + the typed confirmation).');
  }
  const userTag = typeof input?.tag === 'string' ? input.tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) : '';
  return {
    order: {
      symbol, side, quantity, orderType, price, product, exchange,
      triggerAt: triggerAt.toISOString(),
      marketProtection: Number.isFinite(marketProtection) ? marketProtection : -1,
      autoslice: input?.autoslice !== false,
      // An opted-in order always has a tag, so it can be found in Kite's order book after an unknown outcome.
      tag: exits && !userTag ? liveTag(day, symbol, 'entry', 1) : userTag,
      note: typeof input?.note === 'string' ? input.note.slice(0, 200) : '',
      ...(exits ? { exits, gapAutoSize: input?.gapAutoSize === true } : {}),
    },
    warnings,
  };
}

/** How soon to reload after an order fires: its result normally arrives within a second or two. */
export const RESULT_CHECK_MS = 1_500;
/** While an order is sending (or past due but not yet reported), check this often. */
export const SENDING_CHECK_MS = 2_000;

/**
 * Milliseconds until the Orders page should next reload the list (Orders page), or null when
 * nothing is pending: shortly after the next order's time, or soon while one
 * is sending or overdue. (Timers longer than ~24 days aren't possible; cap.)
 */
export function nextCheckDelay(orders, nowMs) {
  const pending = orders.filter((o) => o.status === 'scheduled' || o.status === 'placing');
  if (!pending.length) return null;
  if (pending.some((o) => o.status === 'placing' || new Date(o.triggerAt) <= nowMs)) return SENDING_CHECK_MS;
  const next = Math.min(...pending.map((o) => +new Date(o.triggerAt)));
  return Math.min(next - nowMs + RESULT_CHECK_MS, 2 ** 31 - 1);
}

/** Kite order form fields for a scheduled order. */
export function kiteOrderFor(o) {
  return {
    exchange: o.exchange,
    tradingsymbol: o.symbol,
    transaction_type: o.side,
    quantity: o.sendQuantity ?? o.quantity,
    product: o.product,
    order_type: o.orderType,
    validity: 'DAY',
    variety: 'regular',
    ...(o.orderType === 'LIMIT' ? { price: o.price } : { market_protection: o.marketProtection, autoslice: o.autoslice }),
    ...(o.tag ? { tag: o.tag } : {}),
  };
}

/**
 * Sends orders at an exact time, one after another within Kite's rate limit.
 * Used inline (phone, tests) and inside the backend's worker thread
 * (server/orderSenderWorker.js). Results are plain objects, so they can cross
 * the thread boundary:
 *   { ok: true, orderId, sentAt, confirmedAt, attempts }
 *   { ok: false, message, status, errorType, unknown, at, attempts }
 * A 429 (refused for speed, so not placed) is retried once; nothing else is
 * ever resent, because it may have reached Kite.
 * `warm(session)` (optional) opens the connection to Kite before the time;
 * `spin` checks the clock continuously for the last SPIN_MS (worker thread only).
 */
export function createOrderSender({ placeOrder, warm = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), spin = false }) {
  let queue = Promise.resolve();
  let lastSendAt = 0;

  async function waitUntil(t) {
    for (;;) {
      const left = t - now();
      if (left <= 0) return;
      if (spin && left <= SPIN_MS) {
        while (now() < t) { /* worker thread: nothing else waits on this loop */ }
        return;
      }
      await sleep(spin ? left - SPIN_MS : left);
    }
  }

  async function sendOne({ order, session, due, grace }) {
    if (warm && due - now() > 0) warm(session).catch(() => {}); // best effort; the order doesn't wait for it
    await waitUntil(Math.max(due, lastSendAt + SEND_SPACING_MS));
    for (let attempt = 1; ; attempt++) {
      const sentAt = now();
      lastSendAt = sentAt;
      try {
        const response = await placeOrder({ apiKey: session.apiKey, accessToken: session.accessToken, order });
        return { ok: true, orderId: response?.order_id ?? null, sentAt, confirmedAt: now(), attempts: attempt };
      } catch (error) {
        if (error?.status === 429 && attempt === 1 && now() - due + RATE_RETRY_MS <= grace) {
          await sleep(RATE_RETRY_MS);
          continue;
        }
        return {
          ok: false, message: String(error?.message ?? error), status: error?.status ?? null,
          errorType: error?.data?.error_type ?? null, unknown: Boolean(error?.unknown), at: now(), attempts: attempt,
        };
      }
    }
  }

  return {
    /** Send `order` at `due` (epoch ms); `grace` limits the 429 retry. Resolves with the result. */
    send(job) {
      const run = queue.then(() => sendOne(job));
      queue = run.catch(() => {});
      return run;
    },
  };
}

/**
 * Kite's own record of an order, from its history (GET /orders/:id, oldest state
 * first) and trades (GET /orders/:id/trades). Kite's times are IST, to the second.
 *   receivedAt  when Kite registered the order (first state's order_timestamp)
 *   exchangeAt  when the exchange registered it (first exchange_timestamp)
 *   updatedAt   the latest exchange update (e.g. when it completed)
 *   fills       each execution: { at (fill_timestamp), quantity, price }
 */
export function kiteTimeline(history = [], trades = []) {
  const last = history.at(-1) ?? null;
  const fills = trades
    .map((t) => ({ at: t.fill_timestamp ?? t.exchange_timestamp ?? null, quantity: Number(t.quantity) || 0, price: Number(t.average_price) || null }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    status: last?.status ?? null,
    statusMessage: last?.status_message ?? null,
    receivedAt: history[0]?.order_timestamp ?? null,
    exchangeAt: history.find((s) => s.exchange_timestamp)?.exchange_timestamp ?? null,
    updatedAt: last?.exchange_update_timestamp ?? last?.exchange_timestamp ?? null,
    quantity: last?.quantity ?? null,
    filledQuantity: last?.filled_quantity ?? null,
    averagePrice: Number(last?.average_price) || null,
    fills,
    final: FINAL_STATUSES.includes(last?.status),
  };
}

/**
 * `placeOrder({ apiKey, accessToken, order })` is the Kite client's.
 * `store` is a JSON store; `onChange(list)` is told about every status change.
 * `sender` (optional): something with `send(job)` like createOrderSender's; the
 * backend passes its worker-thread sender. Default: an inline sender on `placeOrder`.
 * `orderDetails({ apiKey, accessToken, orderId })` (optional) returns
 * { history, trades } from Kite, for the timeline of a placed order.
 */
export function createOrderScheduler({
  store, placeOrder, calendar, now = () => new Date(), onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, sender = null, orderDetails = null,
  // Network time minus this PC's clock, in ms (server/networkClock.js). Orders are timed on network time.
  clockOffsetMs = () => 0, clockStatus = () => null,
  // LIVE gap exits (PC backend only): { armed(date), size(order) → { quantity, plan, reason }, onPlaced(order) }.
  gapExits = null,
}) {
  /** Network time as a Date: the scheduler's clock (every trigger, check and timestamp uses it). */
  const netNow = () => new Date(+now() + clockOffsetMs());
  let orders = [];
  let session = null; // { apiKey, accessToken, userId } — memory only
  const timers = new Map();
  const kiteTimers = new Map(); // order id -> timer for the next look at Kite's record
  let loaded = null;
  let nextId = 1;
  const send = sender ?? createOrderSender({ placeOrder, now: () => +now(), sleep: (ms) => new Promise((r) => setTimer(r, ms)) });

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

  /** Wake PREARM_MS before the order's time (see fire). */
  const sizeTimers = new Map();
  /** At 09:14:00, an opted-in order with auto-size gets min(entered, gap plan) shares (never more than entered). */
  function armSize(o) {
    clearTimer(sizeTimers.get(o.id));
    if (o.status !== 'scheduled' || !o.gapAutoSize || !gapExits?.size || o.sizing) return;
    const at = +istInstant(indiaDate(new Date(o.triggerAt)), '09:14') - netNow();
    sizeTimers.set(o.id, setTimer(() => { sizeNow(o.id).catch(() => {}); }, Math.max(0, Math.min(at, MAX_TIMER_MS))));
  }
  async function sizeNow(id) {
    const o = orders.find((x) => x.id === id);
    if (!o || o.status !== 'scheduled' || o.sizing) return;
    const r = await gapExits.size(o).catch((error) => ({ quantity: null, reason: `no gap plan: ${error.message}` }));
    const sent = r?.quantity > 0 ? Math.min(o.quantity, r.quantity) : o.quantity;
    await update(o, {
      sendQuantity: sent,
      sizing: { entered: o.quantity, plan: r?.quantity ?? null, sent, reason: r?.quantity > 0 ? (r.quantity < o.quantity ? `gap plan: ${r.reason}` : 'gap plan allows the entered quantity') : (r?.reason ?? 'no gap plan: the entered quantity'), at: netNow().toISOString() },
    });
  }

  function arm(o) {
    armSize(o);
    clearTimer(timers.get(o.id));
    if (o.status !== 'scheduled') return;
    const delay = new Date(o.triggerAt) - PREARM_MS - netNow();
    timers.set(o.id, setTimer(() => { fire(o.id).catch(() => {}); }, Math.max(0, Math.min(delay, MAX_TIMER_MS))));
  }

  /**
   * PREARM_MS before the time: check the session and save "placing" (from here a
   * crash never resends it), then hand the order to the sender, which sends it at
   * the exact time (or now, if the time has passed within the grace period).
   */
  async function fire(id) {
    const o = orders.find((x) => x.id === id);
    if (!o || o.status !== 'scheduled') return o;
    const t = netNow();
    const due = new Date(o.triggerAt);
    if (t < due - PREARM_MS - 20) { arm(o); return o; } // woke early (or a long wait in steps)
    if (t - due > ORDER_GRACE_MS) {
      await update(o, { status: 'missed', result: { error: `Not sent: the app wasn't running at ${istTime(due)} (checked ${Math.round((t - due) / 1000)} s later).` } });
      return o;
    }
    if (!session?.accessToken) {
      await update(o, { status: 'failed', result: { error: 'Kite was not connected at the trigger time. Log in to Kite in Settings (and keep the app open so it can hand the session over).' } });
      return o;
    }
    // An opted-in order goes only with its live exits armed: never a live entry without them.
    if (o.exits === 'gap' && !gapExits?.armed?.(indiaDate(due))) {
      await update(o, { status: 'failed', result: { error: 'Not sent: live gap exits are not armed today (Settings: the switch and today\'s typed confirmation). Nothing reached Kite.' } });
      return o;
    }
    if (o.gapAutoSize && !o.sizing) await sizeNow(o.id).catch(() => {});
    await update(o, { status: 'placing', result: { armedAt: t.toISOString() } });
    // The sender works on the PC clock: give it the target on that clock, and convert its times back.
    const offset = clockOffsetMs();
    const r = await send.send({ order: kiteOrderFor(o), session: { apiKey: session.apiKey, accessToken: session.accessToken }, due: +due - offset, grace: ORDER_GRACE_MS });
    if (r.ok) {
      const sentAt = r.sentAt + offset; // network time the request left
      await update(o, {
        status: 'placed',
        result: {
          orderId: r.orderId,
          sentAt: new Date(sentAt).toISOString(),
          sendDelayMs: sentAt - +due, // from the chosen time to the request leaving (network time)
          kiteMs: r.confirmedAt - r.sentAt, // Kite's round trip
          clockOffsetMs: offset, // the PC clock's error at the send, for checking the timing later
          attempts: r.attempts,
        },
      });
      if (r.orderId) scheduleKiteCheck(o, 0);
      if (o.exits === 'gap') { try { await gapExits?.onPlaced?.(o); } catch { /* the live exits report their own errors */ } }
    } else {
      const expired = r.status === 403 || r.errorType === 'TokenException';
      await update(o, {
        status: 'failed',
        result: {
          error: expired ? `Kite session expired or invalid: log in to Kite again in Settings. (${r.message})` : r.message,
          at: new Date(r.at + offset).toISOString(),
          attempts: r.attempts,
        },
      });
    }
    return o;
  }

  /** Look at Kite's record of a placed order after KITE_CHECK_MS[step], until it is final. */
  function scheduleKiteCheck(o, step) {
    if (!orderDetails || step >= KITE_CHECK_MS.length) return;
    clearTimer(kiteTimers.get(o.id));
    kiteTimers.set(o.id, setTimer(async () => {
      kiteTimers.delete(o.id);
      const k = await checkKite(o).catch(() => null);
      if (!k?.final) scheduleKiteCheck(o, step + 1);
    }, KITE_CHECK_MS[step] - (step ? KITE_CHECK_MS[step - 1] : 0)));
  }

  /** Read Kite's history and trades for a placed order and keep the timeline on it. */
  async function checkKite(o) {
    const orderId = o.result?.orderId;
    if (!orderDetails || !orderId) return null;
    const at = netNow().toISOString();
    let kite;
    try {
      if (!session?.accessToken) throw new Error('Kite is not connected: log in to read the order from Kite.');
      const { history, trades } = await orderDetails({ apiKey: session.apiKey, accessToken: session.accessToken, orderId });
      kite = { ...kiteTimeline(history, trades), checkedAt: at };
    } catch (error) {
      // A failed check keeps the last good record (Kite keeps the day's orders only, so a later check can
      // fail after an earlier one worked) and says when the check failed.
      const last = o.result?.kite && !o.result.kite.error ? o.result.kite : null;
      kite = last ? { ...last, checkError: error.message, checkErrorAt: at } : { error: error.message, checkedAt: at };
    }
    await update(o, { result: { ...o.result, kite } });
    return kite;
  }

  async function load() {
    loaded ??= (async () => {
      orders = (await store.read(FILE))?.orders ?? [];
      nextId = orders.reduce((m, o) => Math.max(m, Number(String(o.id).replace(/\D/g, '')) || 0), 0) + 1;
      const t = netNow();
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
      const { order, warnings } = validateScheduledOrder(input, netNow(), calendar);
      if (order.exits && !gapExits) throw new Error('Live gap exits are only available in the PC backend (never from the phone).');
      const duplicate = orders.find((o) => o.status === 'scheduled' && o.symbol === order.symbol && o.side === order.side
        && o.quantity === order.quantity && o.triggerAt === order.triggerAt && o.orderType === order.orderType && o.price === order.price);
      if (duplicate) throw new Error(`The same order is already scheduled (${duplicate.id}).`);
      const o = { id: `S${nextId++}`, ...order, createdAt: netNow().toISOString(), status: 'scheduled', result: null };
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
      await update(o, { status: 'cancelled', result: { at: netNow().toISOString() } });
      return o;
    },
    /** Read Kite's record of a placed order now (Kite keeps the day's orders only). */
    async refreshKite(id) {
      await load();
      const o = orders.find((x) => x.id === id);
      if (!o) throw new Error('No such scheduled order.');
      if (o.status !== 'placed' || !o.result?.orderId) throw new Error('Only a placed order with a Kite order id can be read from Kite.');
      if (!orderDetails) throw new Error('Reading orders from Kite is not available here.');
      await checkKite(o);
      return o;
    },
    /** The network-clock status for the Orders page (null when the scheduler has no clock). */
    clock: () => clockStatus(),
    fire, // exposed for tests
    stop() {
      for (const t of [...timers.values(), ...kiteTimers.values(), ...sizeTimers.values()]) clearTimer(t);
      timers.clear();
      kiteTimers.clear();
    },
  };
}
