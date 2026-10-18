import { parseTickerMessage } from './kiteTicks.js';
import { redactSecrets } from './kite.js';

/**
 * Kite Connect WebSocket client (wss://ws.kite.trade), written against the
 * documented protocol rather than the kiteconnect package so the same code runs
 * in Node 22+ (built-in WebSocket) and in the Android WebView.
 *
 *  - subscribe(tokens, mode): {"a":"subscribe"} then {"a":"mode"}; remembered and
 *    re-sent after every reconnect.
 *  - binary messages -> onTicks(ticks, receivedAtMs); text messages: "order" ->
 *    onOrder(data), "error"/"message" -> onStatus.
 *  - reconnects with backoff; a connection silent for longer than
 *    SILENCE_LIMIT_MS (Kite sends heartbeats every ~1 s) is treated as dead.
 *  - Kite allows 3000 instruments per connection: more are refused here.
 *  - the access token is part of the URL only; it is redacted from every
 *    status and error passed out.
 */

export const TICKER_URL = 'wss://ws.kite.trade';
export const MAX_TOKENS_PER_CONNECTION = 3000;
export const SILENCE_LIMIT_MS = 10_000;
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
/**
 * An expired login makes the handshake fail without a reason (close code 1006), so after this
 * many attempts in a row that never opened, stop and report instead of retrying forever.
 */
export const MAX_FAILED_OPENS = 6;

export function createKiteTicker({
  apiKey, accessToken, WebSocketImpl = globalThis.WebSocket,
  onTicks = () => {}, onOrder = () => {}, onStatus = () => {},
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if (!WebSocketImpl) throw new Error('No WebSocket support in this runtime (Node 22 or later is needed).');
  const subscriptions = new Map(); // token -> mode
  let ws = null;
  let closedByUser = false;
  let attempt = 0;
  let failedOpens = 0; // attempts in a row that never reached onopen
  let opened = false;
  let lastMessageAt = 0;
  let watchdog = null;
  let reconnectTimer = null;
  let state = 'idle'; // idle | connecting | connected | reconnecting | closed
  const stats = { connects: 0, reconnects: 0, messages: 0, ticks: 0, lastTickAt: null };

  const safe = (text) => redactSecrets(text, accessToken, apiKey);
  const status = (patch) => {
    state = patch.state ?? state;
    try { onStatus({ state, ...stats, ...patch, message: patch.message ? safe(patch.message) : undefined }); } catch { /* listener errors don't matter */ }
  };

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function sendSubscriptions() {
    const byMode = new Map();
    for (const [token, mode] of subscriptions) (byMode.get(mode) ?? byMode.set(mode, []).get(mode)).push(token);
    for (const [mode, tokens] of byMode) {
      send({ a: 'subscribe', v: tokens });
      send({ a: 'mode', v: [mode, tokens] });
    }
  }

  function armWatchdog() {
    clearTimer(watchdog);
    watchdog = setTimer(() => {
      if (state === 'connected' && now() - lastMessageAt >= SILENCE_LIMIT_MS) {
        status({ message: `No data from Kite for ${SILENCE_LIMIT_MS / 1000} s; reconnecting.` });
        try { ws?.close(); } catch { /* already closed */ }
      } else armWatchdog();
    }, SILENCE_LIMIT_MS / 2);
  }

  function scheduleReconnect() {
    if (closedByUser) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt++;
    stats.reconnects++;
    status({ state: 'reconnecting', retryInMs: delay });
    clearTimer(reconnectTimer);
    reconnectTimer = setTimer(open, delay);
  }

  function open() {
    if (closedByUser) return;
    status({ state: 'connecting' });
    const url = `${TICKER_URL}?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(accessToken)}`;
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      status({ message: `Could not open the Kite WebSocket: ${error.message}` });
      scheduleReconnect();
      return;
    }
    ws = socket;
    opened = false;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      attempt = 0;
      failedOpens = 0;
      opened = true;
      stats.connects++;
      lastMessageAt = now();
      status({ state: 'connected' });
      sendSubscriptions();
      armWatchdog();
    };
    socket.onmessage = (event) => {
      const receivedAt = now();
      lastMessageAt = receivedAt;
      stats.messages++;
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'order') { try { onOrder(msg.data, receivedAt); } catch { /* listener */ } }
        else if (msg.type === 'error' || msg.type === 'message') status({ message: `Kite ${msg.type}: ${msg.data}` });
        return;
      }
      let ticks;
      try { ticks = parseTickerMessage(event.data); } catch { return; }
      if (!ticks.length) return; // heartbeat
      stats.ticks += ticks.length;
      stats.lastTickAt = receivedAt;
      try { onTicks(ticks, receivedAt); } catch { /* listener */ }
    };
    socket.onerror = () => status({ message: 'Kite WebSocket error.' });
    socket.onclose = (event) => {
      clearTimer(watchdog);
      if (ws === socket) ws = null;
      if (closedByUser) { status({ state: 'closed' }); return; }
      // 403 on connect = expired or invalid session: retrying won't help.
      if (event?.code === 1008 || /403|forbidden|token/i.test(event?.reason ?? '')) {
        closedByUser = true;
        status({ state: 'closed', message: 'Kite refused the WebSocket session (expired or invalid login). Log in to Kite again.' });
        return;
      }
      if (!opened && ++failedOpens >= MAX_FAILED_OPENS) {
        closedByUser = true;
        status({ state: 'closed', message: `Could not connect to the Kite WebSocket after ${MAX_FAILED_OPENS} attempts. If the Kite login has expired, log in again; otherwise check the internet connection.` });
        return;
      }
      scheduleReconnect();
    };
  }

  return {
    connect() {
      if (state === 'connected' || state === 'connecting') return;
      closedByUser = false;
      open();
    },
    /** Subscribe tokens in a mode ('full' by default). Returns the tokens refused for the 3000 limit. */
    subscribe(tokens, mode = 'full') {
      const refused = [];
      for (const t of tokens) {
        if (!subscriptions.has(t) && subscriptions.size >= MAX_TOKENS_PER_CONNECTION) { refused.push(t); continue; }
        subscriptions.set(t, mode);
      }
      sendSubscriptions();
      return refused;
    },
    unsubscribe(tokens) {
      for (const t of tokens) subscriptions.delete(t);
      send({ a: 'unsubscribe', v: tokens });
    },
    close() {
      closedByUser = true;
      clearTimer(watchdog);
      clearTimer(reconnectTimer);
      try { ws?.close(); } catch { /* already closed */ }
      status({ state: 'closed' });
    },
    status: () => ({ state, subscribed: subscriptions.size, ...stats }),
  };
}
