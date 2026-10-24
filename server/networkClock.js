import dgram from 'node:dgram';

/**
 * Network time for timed orders. This PC's clock can run ahead of or behind real
 * time (on 24 Oct 2026 it was 30 ms ahead, and the Windows Time service is
 * stopped, so nothing corrects it). A scheduled order keyed to the PC clock
 * therefore leaves at the wrong real time: a PC 30 ms fast sends 30 ms early, and
 * Kite can record it as the previous second. This module asks NTP servers for the
 * real time, so the scheduler can fire at network time whatever the PC clock says.
 *
 * Sign convention: `offsetMs` = network time − PC time. Add it to the PC clock
 * to get network time (a PC 30 ms ahead has offsetMs −30).
 */

export const NTP_SERVERS = ['time.windows.com', 'time.google.com'];
/** Re-check this often; the PC clock drifts only a few ms in that time. */
export const SYNC_EVERY_MS = 10 * 60_000;
/** Each server is asked this many times; the fastest reply is the most accurate. */
export const SAMPLES = 4;
/** A reply further off than this is not trusted (a bad server, not a clock error). */
export const MAX_OFFSET_MS = 60_000;
const TIMEOUT_MS = 4_000;
const NTP_EPOCH_S = 2208988800; // seconds from 1900 (NTP) to 1970 (Unix)

/** NTP timestamp (32-bit seconds + fraction) at byte `o` → Unix ms. */
export function ntpToMs(buf, o) {
  return (buf.readUInt32BE(o) - NTP_EPOCH_S) * 1000 + Math.round((buf.readUInt32BE(o + 4) * 1000) / 2 ** 32);
}

/**
 * One SNTP exchange: t0 PC sent, t1 server received, t2 server sent, t3 PC received
 * (all Unix ms). Standard NTP arithmetic.
 */
export function sntpSample({ t0, t1, t2, t3 }) {
  return { offsetMs: ((t1 - t0) + (t2 - t3)) / 2, rttMs: t3 - t0 };
}

/** The server's receive and transmit times from a 48-byte SNTP reply. Throws on anything that isn't a server reply. */
export function parseSntpReply(buf) {
  if (!buf || buf.length < 48) throw new Error('short NTP reply');
  if ((buf[0] & 0x07) !== 4) throw new Error('not a server reply');
  if (buf[1] === 0) throw new Error('server sent a kiss-of-death reply');
  if (buf.readUInt32BE(40) === 0 && buf.readUInt32BE(44) === 0) throw new Error('empty NTP reply');
  return { t1: ntpToMs(buf, 32), t2: ntpToMs(buf, 40) };
}

/** Real UDP query to one server. Resolves with { t0, t1, t2, t3 }; t3 is taken when the reply arrives. */
export function sntpQuery(host, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const request = Buffer.alloc(48);
    request[0] = 0x1b; // version 3, client mode
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${host} did not reply`)); }, timeoutMs);
    socket.on('message', (msg) => {
      const t3 = Date.now();
      clearTimeout(timer);
      socket.close();
      try { resolve({ t0, ...parseSntpReply(msg), t3 }); }
      catch (error) { reject(error); }
    });
    socket.on('error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
    const t0 = Date.now();
    socket.send(request, 123, host, (error) => { if (error) { clearTimeout(timer); socket.close(); reject(error); } });
  });
}

/**
 * The network clock: `offsetMs()` is the last good offset (0 until one is measured);
 * `status()` says whether it is current, when it was measured and why it isn't.
 * `query` and `now` are injectable for tests.
 */
export function createNetworkClock({
  servers = NTP_SERVERS, query = sntpQuery, samples = SAMPLES, syncEveryMs = SYNC_EVERY_MS,
  setTimer = setInterval, clearTimer = clearInterval,
} = {}) {
  let offset = 0;
  let state = { synced: false, offsetMs: null, syncedAt: null, server: null, rttMs: null, error: 'Network time not checked yet.' };
  let running = null;
  let timer = null;

  async function sync() {
    running ??= (async () => {
      const failures = [];
      for (const server of servers) {
        try {
          const got = [];
          for (let i = 0; i < samples; i++) got.push(sntpSample(await query(server)));
          const best = got.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
          if (!Number.isFinite(best.offsetMs) || Math.abs(best.offsetMs) > MAX_OFFSET_MS) {
            throw new Error(`implausible offset ${Math.round(best.offsetMs)} ms`);
          }
          offset = Math.round(best.offsetMs);
          state = { synced: true, offsetMs: offset, syncedAt: new Date().toISOString(), server, rttMs: best.rttMs, error: null };
          return state;
        } catch (error) {
          failures.push(`${server}: ${error.message}`);
        }
      }
      // Keep the last good offset: the PC clock drifts slowly, so it is still close.
      state = {
        ...state,
        synced: false,
        error: `Network time unavailable (${failures.join('; ')}). ${state.syncedAt ? `Last measured ${state.syncedAt}; ` : ''}orders use the last known offset.`,
      };
      return state;
    })().finally(() => { running = null; });
    return running;
  }

  return {
    offsetMs: () => offset,
    status: () => ({ ...state }),
    sync,
    /** Sync now, then every syncEveryMs. The timer is unref'd so it never keeps the process alive. */
    start() {
      sync().catch(() => {});
      timer ??= setTimer(() => { sync().catch(() => {}); }, syncEveryMs);
      timer?.unref?.();
      return this;
    },
    stop() { clearTimer(timer); timer = null; },
  };
}
