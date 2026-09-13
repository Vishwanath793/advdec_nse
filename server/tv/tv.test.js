import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indiaDate, ordinal, searches, marketDay, readCalendar, nextMarketRun } from './calendar.js';
import { durationSeconds, matchesDate, selectVideo, downsubUrl, validateTranscript } from './browser.js';
import { extractionInput, analyzeTranscripts, completeText } from './analysis.js';
import { createTvService } from './service.js';
import { EXTRACTION_PROMPT, CONSENSUS_PROMPT } from './prompts.js';

test('IST rollover and exact example URL formats', () => {
  assert.equal(indiaDate(new Date('2026-09-11T20:00:00Z')), '2026-09-12');
  assert.deepEqual([1, 2, 3, 11, 12, 13, 21, 31].map(ordinal), ['1st', '2nd', '3rd', '11th', '12th', '13th', '21st', '31st']);
  const s = searches('2026-09-11');
  assert.equal(s[0].url, 'https://www.youtube.com/results?search_query=zee+business+live+first+trade+11th+september');
  assert.equal(s[1].url, 'https://www.youtube.com/results?search_query=cnbc+awaaz+Stock+Market+Updates+%7C+Anuj+Singhal+11th+Sept+2026');
  assert.throws(() => searches('2026-02-30'));
});
test('equity holidays, weekends, missing years and next valid 7pm IST', () => {
  const c = readCalendar();
  for (const d of ['2026-09-12', '2026-09-13', '2026-09-14', '2026-11-08', '2027-01-04']) assert.equal(marketDay(d, c).open, false);
  assert.equal(marketDay('2026-08-26', c).open, true); // currency holiday is not an equity holiday
  assert.equal(marketDay('2026-09-15', c).open, true);
  assert.equal(nextMarketRun(new Date('2026-09-12T12:00:00Z'), c), '2026-09-15T13:30:00.000Z');
  assert.equal(nextMarketRun(new Date('2026-12-31T15:00:00Z'), c), null);
});
test('video selection preserves order and rejects shorts, wrong date, channel and live streams', () => {
  assert.equal(durationSeconds('8:51:34'), 31894);
  assert.equal(durationSeconds('9:01:30\n    9:01:30'), 32490);
  assert.equal(durationSeconds('59:59'), 3599);
  assert.equal(durationSeconds('LIVE'), 0);
  assert.equal(durationSeconds('7:99:00'), 0);
  assert.equal(matchesDate('First Trade 11th September 2026', '2026-09-11'), true);
  assert.equal(matchesDate('First Trade 11th September 2025', '2026-09-11'), false);
  const good = { title: 'First Trade 11th September 2026', channel: 'Zee Business', seconds: 25200 };
  assert.equal(selectVideo([{ ...good, live: true }, { ...good, channel: 'other' }, { ...good, seconds: 25199 }, good], { id: 'zee' }, '2026-09-11'), good);
  const url = 'https://www.youtube.com/watch?v=fLDbQzfnIfo&list=PLAXTuuvfgz00';
  assert.equal(new URL(downsubUrl(url)).searchParams.get('url'), url);
  assert.throws(() => validateTranscript('<html>' + 'error'.repeat(1000)));
});
test('entire transcripts reach API and second request follows completed extraction', async () => {
  const transcripts = ['zee', 'cnbc'].map(show => ({ show, filename: show + '.txt', url: 'https://www.youtube.com/watch?v=fLDbQzfnIfo', text: 'START' + 'क'.repeat(100000) + 'END' }));
  const input = extractionInput(transcripts);
  assert.equal(input[0].content[0].text, EXTRACTION_PROMPT);
  for (let i = 0; i < 2; i++) assert.ok(input[0].content[i + 1].text.includes(transcripts[i].text));
  const requests = [], saved = [];
  const client = { responses: { create: async r => { requests.push(r); return { status: 'completed', output_text: 'result', output: [{ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'result', annotations: [] }] }] }; } } };
  await analyzeTranscripts(transcripts, async kind => saved.push(kind), client);
  assert.deepEqual(saved, ['extraction', 'consensus']);
  assert.equal(requests[1].input.at(-1).content, CONSENSUS_PROMPT);
  assert.equal(requests[0].truncation, 'disabled');
  assert.throws(() => completeText({ status: 'incomplete', output_text: 'partial' }));
});
test('a saved extraction resumes directly at the consensus prompt', async () => {
  const requests = [];
  const client = { responses: { create: async r => { requests.push(r); return { status: 'completed', output_text: 'consensus' }; } } };
  const transcripts = ['zee', 'cnbc'].map(show => ({ show, filename: show + '.txt', url: 'https://youtube.com', text: 'full source' }));
  await analyzeTranscripts(transcripts, async () => {}, client, 'saved full extraction');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input.at(-2).content, 'saved full extraction');
});
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tv-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let instant = new Date('2026-09-15T13:30:00Z');
  let downloads = 0, analyses = 0;
  const service = createTvService({ root, schedule: () => ({ destroy() {} }), now: () => instant, keyReady: () => true,
    browserFactory: async () => ({ discover: async show => ({ url: 'https://www.youtube.com/watch?v=fLDbQzfnIfo', title: show.name }), download: async (_, file) => { downloads++; writeFileSync(file, 'captions '.repeat(500)); return {}; }, close: async () => {}, diagnostic: async () => {} }),
    analyze: async (_, save) => { analyses++; await save('extraction', 'table'); await save('consensus', 'consensus'); }, ...options });
  t.after(() => service.close());
  return { service, setTime: s => instant = new Date(s), counts: () => ({ downloads, analyses }) };
}
test('weekends and holidays make no requests; concurrent and completed dates deduplicate', async t => {
  const f = fixture(t);
  assert.equal((await f.service.run('2026-09-12')).status, 'skipped');
  assert.equal((await f.service.run('2026-09-14')).status, 'skipped');
  assert.deepEqual(f.counts(), { downloads: 0, analyses: 0 });
  const a = f.service.run('2026-09-15');
  assert.equal(f.service.run('2026-09-15'), a);
  assert.equal((await a).status, 'completed');
  await f.service.run('2026-09-15');
  assert.deepEqual(f.counts(), { downloads: 2, analyses: 1 });
  assert.throws(() => f.service.artifact('2026-09-15', '../../.env'));
});
test('retry reuses caption files, persists failure and stops after four attempts', async t => {
  const f = fixture(t, { analyze: async () => { throw new Error('API unavailable'); } });
  f.setTime('2026-09-15T13:29:00Z'); await f.service.tick();
  assert.equal(f.service.status().history.length, 0);
  f.setTime('2026-09-15T13:30:00Z'); await f.service.tick();
  assert.equal(f.service.load('2026-09-15').error, 'API unavailable');
  f.setTime('2026-09-15T13:59:00Z'); await f.service.tick();
  assert.equal(f.service.load('2026-09-15').attempts, 1);
  for (const time of ['14:00', '14:30', '15:00', '15:30']) { f.setTime(`2026-09-15T${time}:00Z`); await f.service.tick(); }
  assert.equal(f.service.load('2026-09-15').attempts, 4);
  assert.equal(f.counts().downloads, 2);
});
