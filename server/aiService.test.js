import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { readCalendar } from './tv/calendar.js';
import { fsStore } from './fsStore.js';
import { aiConfig } from './ai/config.js';
import { createAiService } from './ai/service.js';
import { addAiRoutes } from './ai/routes.js';
import { fixtureSnapshots } from './fixtures/aiFixture.js';

/** The AI service over HTTP and its indexing worker thread, on a temporary data folder (no network). */
async function start({ env = { AI_PROVIDER: 'mock' }, now = () => new Date('2026-10-26T10:00:00Z') } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-svc-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-repo-'));
  writeFileSync(join(repoRoot, 'README.md'), '# Readme\n\nThe Analyzer shows the advance/decline split.\n');
  writeFileSync(join(repoRoot, '.env'), 'AI_API_KEY=sk-should-never-be-indexed-123456\n');
  mkdirSync(join(dataDir, 'ai', 'notes'), { recursive: true });
  writeFileSync(join(dataDir, 'ai', 'notes', 'ok.md'), '---\napproved: true\nsymbol: ALPHA\navailableAt: 2026-10-21T13:00:00Z\n---\n# ALPHA note\n\nApproved note.\n');
  writeFileSync(join(dataDir, 'ai', 'notes', 'draft.md'), '---\napproved: false\n---\n# Draft\n\nNot approved.\n');
  const service = createAiService({ store: fsStore(dataDir), dataDir, repoRoot, snapshots: fixtureSnapshots(), calendar: readCalendar(), config: { ...aiConfig(env), quietWindow: null }, now });
  const app = express();
  app.use(express.json());
  addAiRoutes(app, service);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => { server.close(); service.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(repoRoot, { recursive: true, force: true }); };
  return { service, base, close, dataDir };
}

const until = async (fn, ms = 20_000) => {
  const keep = setTimeout(() => {}, ms + 1000); // a ref'd timer while polling (CI runs Node 22)
  try {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally { clearTimeout(keep); }
};

test('routes: status without a key, same-origin only, ids not paths', async () => {
  const { base, close } = await start({ env: {} });
  try {
    const status = await (await fetch(`${base}/api/ai/status`)).json();
    assert.equal(status.config.provider, 'off');
    assert.match(status.config.problem, /AI is not configured/);
    assert.ok(!JSON.stringify(status).includes('sk-'));
    const ask = await fetch(`${base}/api/ai/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'hi' }) });
    assert.equal(ask.status, 503);
    assert.equal((await ask.json()).code, 'not_configured');
    const cross = await fetch(`${base}/api/ai/status`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    for (const id of ['..%2F.env', '%2E%2E%2F%2E%2E%2Fetc%2Fpasswd', 'doc%3A..%2F.env', 'C%3A%5Cx']) {
      const r = await fetch(`${base}/api/ai/source/${id}`);
      assert.equal(r.status, 400, id);
    }
    assert.equal((await fetch(`${base}/api/ai/source/${encodeURIComponent('doc:README.md#readme.0')}`)).status, 400, 'unknown ids are refused');
  } finally { close(); }
});

test('indexing runs in a worker thread; allowlist only; then a question over HTTP', async () => {
  const { base, close } = await start();
  try {
    const started = await (await fetch(`${base}/api/ai/index`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embed: true }) })).json();
    assert.equal(started.state, 'running');
    const status = await until(async () => {
      const s = await (await fetch(`${base}/api/ai/status`)).json();
      return s.job?.state !== 'running' ? s : null;
    });
    assert.equal(status.job.state, 'done', status.job.error);
    const ids = status.index.documents.map((d) => d.docId);
    assert.ok(ids.includes('doc:README.md'));
    assert.ok(ids.includes('glossary:factors'));
    assert.ok(ids.includes('note:ok.md'));
    assert.ok(!ids.includes('note:draft.md'), 'unapproved notes are not indexed');
    assert.ok(!ids.some((d) => d.includes('.env')));
    assert.equal(status.index.missingVectors, 0);
    const chunk = (await (await fetch(`${base}/api/ai/source/${encodeURIComponent('doc:README.md#readme.0')}`)).json());
    assert.match(chunk.text, /advance\/decline/);

    const snaps = (await (await fetch(`${base}/api/ai/snapshots`)).json()).snapshots;
    const recorded = snaps.find((s) => s.source === 'recorded' && s.date === '2026-10-21');
    const { normalizeProfile, profileHash } = await import('../src/utils/aiContext.js');
    const profile = normalizeProfile({});
    const ask = await fetch(`${base}/api/ai/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What did the ALPHA note say?', symbols: ['ALPHA'], mode: 'retrospective', analysis: { source: 'recorded', snapshotId: recorded.snapshotId, profile, profileHash: profileHash(profile) } }),
    });
    const r = await ask.json();
    assert.equal(ask.status, 200, r.error);
    assert.equal(r.dataDate, '2026-10-21');
    assert.ok(r.sources.length > 0);
    const usage = (await (await fetch(`${base}/api/ai/status`)).json()).usage;
    assert.ok(usage.calls >= 1);
  } finally { close(); }
});
