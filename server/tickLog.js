import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync, strFromU8 } from 'fflate';

/**
 * The opening window's raw ticks, one file per day: .data/ticks/YYYY-MM-DD.ndjson
 * while recording, gzipped to .ndjson.gz when the recording closes (about a
 * tenth of the size). Lines:
 *   {"type":"meta","date":…,"meta":{token: instrument}}
 *   [receivedAtMs, token, exchangeTimeMs, ltp, volume, avgPrice, buyQty, sellQty,
 *    open, high, low, close, oi, lastTradeTimeMs, lastQty, depth|null]
 * where depth is [[qty, price, orders] ×5 bids, then ×5 offers]. Index ticks
 * leave the stock-only fields null. Writes are buffered and flushed every second.
 * This recording is the only source of depth history (Kite has none).
 */

export const TICK_FIELDS = ['receivedAt', 'token', 'exchangeTime', 'ltp', 'volume', 'avgPrice', 'buyQty', 'sellQty', 'open', 'high', 'low', 'close', 'oi', 'lastTradeTime', 'lastQty', 'depth'];

export function tickLine(t, receivedAt) {
  const depth = t.depth ? [...t.depth.buy, ...t.depth.sell].map((l) => [l.qty, l.price, l.orders]) : null;
  return JSON.stringify([receivedAt, t.token, t.exchangeTime ?? null, t.ltp ?? null, t.volume ?? null, t.avgPrice ?? null, t.buyQty ?? null, t.sellQty ?? null,
    t.open ?? null, t.high ?? null, t.low ?? null, t.close ?? null, t.oi ?? null, t.lastTradeTime ?? null, t.lastQty ?? null, depth]);
}

/** Parse a recorded line back into { tick, receivedAt } (for replays). */
export function parseTickLine(line, meta = {}) {
  const v = JSON.parse(line);
  if (!Array.isArray(v)) return null;
  const [receivedAt, token, exchangeTime, ltp, volume, avgPrice, buyQty, sellQty, open, high, low, close, oi, lastTradeTime, lastQty, depth] = v;
  const index = meta[token]?.kind === 'index';
  const tick = { token, ltp, exchangeTime, open, high, low, close, index, mode: 'full' };
  if (!index) {
    Object.assign(tick, { volume, avgPrice, buyQty, sellQty, oi, lastTradeTime, lastQty });
    if (depth) {
      const level = ([qty, price, orders]) => ({ qty, price, orders });
      tick.depth = { buy: depth.slice(0, 5).map(level), sell: depth.slice(5, 10).map(level) };
    }
  }
  return { tick, receivedAt };
}

export function createTickLog(dir) {
  let file = null;
  let buffer = [];
  let flushTimer = null;
  const flush = () => {
    if (file && buffer.length) { appendFileSync(file, buffer.join('\n') + '\n'); buffer = []; }
  };
  return {
    open(date, { meta }) {
      mkdirSync(dir, { recursive: true });
      file = join(dir, `${date}.ndjson`);
      if (!existsSync(file)) writeFileSync(file, `${JSON.stringify({ type: 'meta', date, fields: TICK_FIELDS, meta })}\n`);
      flushTimer = setInterval(flush, 1000);
    },
    append(ticks, receivedAt) {
      if (!file) return;
      for (const t of ticks) buffer.push(tickLine(t, receivedAt));
    },
    close() {
      clearInterval(flushTimer);
      flush();
      if (file && existsSync(file)) {
        writeFileSync(`${file}.gz`, gzipSync(readFileSync(file)));
        rmSync(file);
      }
      file = null;
    },
    /** Recorded ticks for a date: { meta, ticks: [{ tick, receivedAt }] } or null. */
    read(date) {
      const gz = join(dir, `${date}.ndjson.gz`);
      const plain = join(dir, `${date}.ndjson`);
      const text = existsSync(gz) ? strFromU8(gunzipSync(readFileSync(gz))) : existsSync(plain) ? readFileSync(plain, 'utf8') : null;
      if (!text) return null;
      const [head, ...lines] = text.trim().split('\n');
      const { meta } = JSON.parse(head);
      return { date, meta, ticks: lines.map((l) => parseTickLine(l, meta)).filter(Boolean) };
    },
  };
}

