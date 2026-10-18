/**
 * Kite Connect WebSocket binary packets (https://kite.trade/docs/connect/v3/websocket/).
 *
 * A binary message is: int16 packet count, then for each packet an int16 length
 * and the packet. All fields are big-endian int32 except the depth "orders"
 * (int16). Equity/F&O prices are in paise (÷100). Packet sizes:
 *   8   LTP mode:   token, last price
 *   28  index quote: token, last, high, low, open, close, change
 *   32  index full:  ... + exchange timestamp
 *   44  quote mode: token, last, last qty, avg price, volume, buy qty, sell qty, open, high, low, close
 *   184 full mode:  ... + last trade time, OI, OI day high, OI day low, exchange timestamp, depth
 * Depth: 5 bids then 5 offers, 12 bytes each (qty int32, price int32, orders int16, 2 padding).
 * Timestamps are Unix seconds; they are returned here in milliseconds.
 * A 1-byte message is a heartbeat.
 */

export const PACKET_SIZE = { ltp: 8, indexQuote: 28, indexFull: 32, quote: 44, full: 184 };
const PRICE_DIVISOR = 100; // NSE / NFO; currency segments would use 10,000,000

const view = (data) => {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Binary ticker data expected.');
};

function parsePacket(dv, at, size) {
  const int = (o) => dv.getInt32(at + o);
  const price = (o) => int(o) / PRICE_DIVISOR;
  const time = (o) => (int(o) > 0 ? int(o) * 1000 : null);
  const token = dv.getUint32(at);
  if (size === PACKET_SIZE.ltp) return { token, mode: 'ltp', ltp: price(4) };
  if (size === PACKET_SIZE.indexQuote || size === PACKET_SIZE.indexFull) {
    return {
      token, mode: size === PACKET_SIZE.indexFull ? 'full' : 'quote', index: true,
      ltp: price(4), high: price(8), low: price(12), open: price(16), close: price(20), change: price(24),
      exchangeTime: size === PACKET_SIZE.indexFull ? time(28) : null,
    };
  }
  if (size === PACKET_SIZE.quote || size === PACKET_SIZE.full) {
    const tick = {
      token, mode: size === PACKET_SIZE.full ? 'full' : 'quote', index: false,
      ltp: price(4), lastQty: int(8), avgPrice: price(12), volume: int(16), buyQty: int(20), sellQty: int(24),
      open: price(28), high: price(32), low: price(36), close: price(40),
    };
    if (size === PACKET_SIZE.full) {
      Object.assign(tick, { lastTradeTime: time(44), oi: int(48), oiDayHigh: int(52), oiDayLow: int(56), exchangeTime: time(60) });
      const level = (o) => ({ qty: int(o), price: price(o + 4), orders: dv.getInt16(at + o + 8) });
      tick.depth = {
        buy: [0, 1, 2, 3, 4].map((i) => level(64 + i * 12)),
        sell: [0, 1, 2, 3, 4].map((i) => level(124 + i * 12)),
      };
    }
    return tick;
  }
  return { token, mode: 'unknown', size };
}

/** Decode one binary message into ticks; a heartbeat (1 byte) or empty message gives []. */
export function parseTickerMessage(data) {
  const dv = view(data);
  if (dv.byteLength < 4) return [];
  const count = dv.getInt16(0);
  const ticks = [];
  let at = 2;
  for (let i = 0; i < count && at + 2 <= dv.byteLength; i++) {
    const size = dv.getInt16(at);
    at += 2;
    if (size <= 0 || at + size > dv.byteLength) break; // truncated message: stop, keep what parsed
    ticks.push(parsePacket(dv, at, size));
    at += size;
  }
  return ticks;
}

/**
 * Build a binary message from tick objects (the inverse of parseTickerMessage).
 * Used for test fixtures and the simulated morning; prices are rounded to paise.
 */
export function encodeTickerMessage(ticks) {
  const sizeOf = (t) => (t.index ? (t.exchangeTime != null ? PACKET_SIZE.indexFull : PACKET_SIZE.indexQuote)
    : t.mode === 'ltp' ? PACKET_SIZE.ltp : t.depth || t.exchangeTime != null ? PACKET_SIZE.full : PACKET_SIZE.quote);
  const sizes = ticks.map(sizeOf);
  const buffer = new ArrayBuffer(2 + sizes.reduce((s, n) => s + 2 + n, 0));
  const dv = new DataView(buffer);
  dv.setInt16(0, ticks.length);
  let at = 2;
  ticks.forEach((t, i) => {
    const size = sizes[i];
    dv.setInt16(at, size);
    at += 2;
    const int = (o, v) => dv.setInt32(at + o, Math.round(v ?? 0));
    const price = (o, v) => int(o, (v ?? 0) * PRICE_DIVISOR);
    const time = (o, ms) => int(o, ms ? Math.floor(ms / 1000) : 0);
    dv.setUint32(at, t.token);
    price(4, t.ltp);
    if (t.index) {
      if (size >= PACKET_SIZE.indexQuote) { price(8, t.high); price(12, t.low); price(16, t.open); price(20, t.close); price(24, t.change); }
      if (size === PACKET_SIZE.indexFull) time(28, t.exchangeTime);
    } else if (size >= PACKET_SIZE.quote) {
      int(8, t.lastQty); price(12, t.avgPrice); int(16, t.volume); int(20, t.buyQty); int(24, t.sellQty);
      price(28, t.open); price(32, t.high); price(36, t.low); price(40, t.close);
      if (size === PACKET_SIZE.full) {
        time(44, t.lastTradeTime); int(48, t.oi); int(52, t.oiDayHigh); int(56, t.oiDayLow); time(60, t.exchangeTime);
        const levels = [...(t.depth?.buy ?? []), ...Array(5).fill(null)].slice(0, 5).concat([...(t.depth?.sell ?? []), ...Array(5).fill(null)].slice(0, 5));
        levels.forEach((l, k) => {
          const o = 64 + k * 12;
          int(o, l?.qty ?? 0);
          price(o + 4, l?.price ?? 0);
          dv.setInt16(at + o + 8, l?.orders ?? 0);
        });
      }
    }
    at += size;
  });
  return new Uint8Array(buffer);
}
