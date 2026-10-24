import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkClock, MAX_OFFSET_MS, NTP_SERVERS, ntpToMs, parseSntpReply, sntpSample } from './networkClock.js';

// Offline: the NTP exchange is replaced by known replies. No network access in tests.

const NTP_EPOCH_S = 2208988800;

/** A 48-byte server reply whose receive and transmit times are the given Unix ms. */
function reply({ mode = 4, stratum = 2, receiveMs, transmitMs }) {
  const buf = Buffer.alloc(48);
  buf[0] = (0 << 6) | (4 << 3) | mode; // LI 0, version 4, mode
  buf[1] = stratum;
  const put = (o, ms) => {
    const s = Math.floor(ms / 1000) + NTP_EPOCH_S;
    const frac = Math.round(((ms % 1000) / 1000) * 2 ** 32);
    buf.writeUInt32BE(s >>> 0, o);
    buf.writeUInt32BE(frac >>> 0, o + 4);
  };
  put(32, receiveMs);
  put(40, transmitMs);
  return buf;
}

test('an SNTP sample: offset is network minus PC, using the standard four timestamps', () => {
  // The PC sends at 1000, the server gets it at 1020 and answers at 1021, the PC hears back at 1050.
  const s = sntpSample({ t0: 1000, t1: 1020, t2: 1021, t3: 1050 });
  assert.equal(s.offsetMs, -4.5);
  assert.equal(s.rttMs, 50);
  // A PC 30 ms ahead of a server that is exactly right: the offset is −30.
  const ahead = sntpSample({ t0: 10_030, t1: 10_000, t2: 10_000, t3: 10_030 });
  assert.equal(Math.round(ahead.offsetMs), -30);
});

test('a reply is parsed to the server times; NTP fractions convert to ms', () => {
  const buf = reply({ receiveMs: 1_761_300_000_250, transmitMs: 1_761_300_000_750 });
  assert.deepEqual(parseSntpReply(buf), { t1: 1_761_300_000_250, t2: 1_761_300_000_750 });
  assert.equal(ntpToMs(buf, 32), 1_761_300_000_250);
});

test('replies that are not a server answer are refused', () => {
  const good = reply({ receiveMs: 1_761_300_000_000, transmitMs: 1_761_300_000_000 });
  assert.throws(() => parseSntpReply(good.subarray(0, 40)), /short/);
  assert.throws(() => parseSntpReply(reply({ mode: 3, receiveMs: 1_761_300_000_000, transmitMs: 1_761_300_000_000 })), /not a server reply/);
  assert.throws(() => parseSntpReply(reply({ stratum: 0, receiveMs: 1_761_300_000_000, transmitMs: 1_761_300_000_000 })), /kiss-of-death/);
  const empty = Buffer.alloc(48); empty[0] = 0x1c; empty[1] = 2;
  assert.throws(() => parseSntpReply(empty), /empty/);
});

/** A fake query: each server returns the given [offset, rtt] samples in turn. */
function fakeQuery(script) {
  const calls = [];
  const query = async (server) => {
    calls.push(server);
    const next = script[server]?.shift();
    if (!next) throw new Error(`${server} did not reply`);
    if (next instanceof Error) throw next;
    const [offset, rtt] = next;
    // PC time 1_000_000; the server is `offset` ms ahead of it; the reply comes back after `rtt` ms.
    const t0 = 1_000_000;
    return { t0, t1: t0 + rtt / 2 + offset, t2: t0 + rtt / 2 + offset, t3: t0 + rtt };
  };
  return { query, calls };
}

test('the fastest of several samples is used, and the offset is kept with its server and time', async () => {
  const { query } = fakeQuery({ 'time.windows.com': [[-35, 80], [-30, 17], [-31, 40], [-29, 22]] });
  const clock = createNetworkClock({ servers: ['time.windows.com'], query, samples: 4 });
  const s = await clock.sync();
  assert.equal(s.synced, true);
  assert.equal(s.offsetMs, -30); // the 17 ms round trip is the most accurate
  assert.equal(s.server, 'time.windows.com');
  assert.equal(s.rttMs, 17);
  assert.equal(clock.offsetMs(), -30);
  assert.ok(Date.parse(s.syncedAt) > 0);
});

test('when the first server fails, the next one is used and the failure is not hidden', async () => {
  const { query, calls } = fakeQuery({
    'time.windows.com': [new Error('timeout'), new Error('timeout'), new Error('timeout'), new Error('timeout')],
    'time.google.com': [[-30, 58], [-30, 60], [-31, 61], [-29, 62]],
  });
  const clock = createNetworkClock({ servers: NTP_SERVERS, query, samples: 4 });
  const s = await clock.sync();
  assert.equal(s.synced, true);
  assert.equal(s.server, 'time.google.com');
  assert.deepEqual([...new Set(calls)], ['time.windows.com', 'time.google.com']);
});

test('an implausible offset is refused, not used to move every order', async () => {
  const { query } = fakeQuery({ 'time.windows.com': [[MAX_OFFSET_MS + 5_000, 20], [MAX_OFFSET_MS + 5_000, 21], [0, 90], [0, 91]] });
  const clock = createNetworkClock({ servers: ['time.windows.com'], query, samples: 2 });
  const s = await clock.sync();
  assert.equal(s.synced, false);
  assert.match(s.error, /implausible offset/);
  assert.equal(clock.offsetMs(), 0);
});

test('when every server fails, the last good offset is kept and the status says so', async () => {
  const { query } = fakeQuery({ 'a.example': [[-30, 17]], 'b.example': [new Error('no route')] });
  const clock = createNetworkClock({ servers: ['a.example', 'b.example'], query, samples: 1 });
  assert.equal((await clock.sync()).synced, true);
  // Next round: both fail. The offset from the last good round stays in use.
  const s = await clock.sync();
  assert.equal(s.synced, false);
  assert.equal(clock.offsetMs(), -30);
  assert.match(s.error, /Network time unavailable/);
  assert.match(s.error, /Last measured/);
});

test('before any sync the offset is 0 and the status says it has not been checked', () => {
  const clock = createNetworkClock({ servers: [], query: async () => { throw new Error('x'); } });
  assert.equal(clock.offsetMs(), 0);
  assert.equal(clock.status().synced, false);
  assert.match(clock.status().error, /not checked yet/);
});

test('start syncs at once and then on a timer that never keeps the process alive; stop clears it', async () => {
  const { query } = fakeQuery({ 'time.windows.com': [[-30, 17], [-30, 17], [-30, 17], [-30, 17], [-29, 18], [-29, 18], [-29, 18], [-29, 18]] });
  const timers = [];
  const cleared = [];
  const clock = createNetworkClock({
    servers: ['time.windows.com'], query, samples: 4, syncEveryMs: 600_000,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() { this.unrefd = true; return this; } }; timers.push(t); return t; },
    clearTimer: (t) => cleared.push(t),
  });
  clock.start();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(clock.offsetMs(), -30);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 600_000);
  assert.equal(timers[0].unrefd, true);
  clock.stop();
  assert.deepEqual(cleared, [timers[0]]);
});

test('the default servers are the Windows and Google time servers', () => {
  assert.deepEqual(NTP_SERVERS, ['time.windows.com', 'time.google.com']);
});
