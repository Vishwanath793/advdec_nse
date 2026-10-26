import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fromColumns } from '../../../src/core/recorder.js';
import { BHAV_READY_TIME, unpackDay } from '../../../src/core/marketContext.js';
import { istInstant } from '../../../src/core/calendar.js';
import { buildGlossary, GLOSSARY_VERSION } from './glossary.js';
import { morningSummary, outcomeSummary, SUMMARY_VERSION } from './summaries.js';
import { redactSecrets } from '../errors.js';

/**
 * The documents the AI Analyst may index: an explicit allowlist, never a
 * recursive walk of the repository or of .data. Excluded by construction:
 * .env, keys and tokens, sessions, orders, browser profiles, logs, ticks,
 * node_modules. Every text is passed through redactSecrets before indexing.
 *
 * Each document: { docId, sourceType, sourceRef, title, kind, symbol, isin,
 * tradingDate, availableAt, publishedAt, version, text }.
 *   kind 'methodology': how the app works (current code and docs); not market evidence.
 *   kind 'market': evidence about a date; strict as-known answers use it only
 *     when its availableAt is at or before the cutoff (and never when unknown).
 */

/** Project documents, relative to the repository root. */
export const DOC_ALLOWLIST = [
  { path: 'README.md', title: 'README' },
  { path: 'android/README.md', title: 'Android app README' },
  { path: 'CLAUDE.md', title: 'Project handoff (CLAUDE.md)' },
  { path: 'DEVLOG.md', title: 'Development log' },
  { path: 'docs/ai-analyst.md', title: 'AI Analyst guide' },
  { path: 'docs/analyzer-review-2026-10-21.md', title: 'Analyzer review, 21 Oct 2026' },
];

const DENY = /(^|[\\/])(\.env[^\\/]*|node_modules|browser-profile|\.git)([\\/]|$)|\.(log|ndjson|gz)$/i;
const NOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A path inside `root` that is on no deny list, or throws. */
export function safeJoin(root, ...parts) {
  const base = resolve(root);
  const full = resolve(base, ...parts);
  const rel = relative(base, full);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(base, rel) !== full || DENY.test(rel)) {
    throw new Error('Path not allowed.');
  }
  return full;
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** Simple front matter: `---\nkey: value\n---`. */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

const iso = (v) => {
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(+d) ? d.toISOString() : null;
};

export function collectSources({ repoRoot, dataDir, config = {}, now = () => new Date() }) {
  const docs = [];
  const errors = [];
  const add = (doc) => docs.push({ symbol: null, isin: null, tradingDate: null, publishedAt: null, ...doc, text: redactSecrets(doc.text) });

  for (const { path, title } of DOC_ALLOWLIST) {
    try {
      const file = safeJoin(repoRoot, path);
      if (!existsSync(file)) continue;
      const mtime = statSync(file).mtime.toISOString();
      add({ docId: `doc:${path}`, sourceType: 'doc', sourceRef: path, title, kind: 'methodology', availableAt: mtime, publishedAt: mtime, version: 'file', text: readFileSync(file, 'utf8') });
    } catch (error) { errors.push(`${path}: ${error.message}`); }
  }

  add({ docId: 'glossary:factors', sourceType: 'glossary', sourceRef: 'generated from src/utils (conviction, History, Auction, screener)', title: 'Factor glossary', kind: 'methodology', availableAt: now().toISOString(), version: `glossary-v${GLOSSARY_VERSION}`, text: buildGlossary() });

  // Approved research notes: .data/ai/notes/*.md with "approved: true" in the front matter.
  try {
    const dir = safeJoin(dataDir, 'ai', 'notes');
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).filter((n) => NOTE_NAME.test(n)).sort()) {
        const { meta, body } = frontMatter(readFileSync(safeJoin(dir, name), 'utf8'));
        if (meta.approved !== 'true') continue;
        add({
          docId: `note:${name}`, sourceType: 'note', sourceRef: `.data/ai/notes/${name}`, title: meta.title || name.replace(/\.md$/, ''), kind: 'market',
          symbol: /^[A-Z0-9&-]{1,20}$/.test(meta.symbol ?? '') ? meta.symbol : null,
          tradingDate: DATE.test(meta.tradingDate ?? '') ? meta.tradingDate : null,
          availableAt: iso(meta.availableAt), // unknown availability: excluded from strict as-known answers
          publishedAt: iso(meta.publishedAt ?? meta.availableAt), version: meta.version || 'note', text: body,
        });
      }
    }
  } catch (error) { errors.push(`notes: ${error.message}`); }

  // Recorded days: a morning summary, and once the end-of-day file is stored, an outcome summary.
  const index = readJson(join(dataDir, 'recorded', 'index.json'));
  const masters = new Map();
  for (const { date } of index?.days ?? []) {
    if (!DATE.test(date)) continue;
    try {
      const day = readJson(safeJoin(dataDir, 'recorded', `${date}.json`));
      if (!day?.snapshot) continue;
      if (day.masterId && !masters.has(day.masterId)) masters.set(day.masterId, readJson(safeJoin(dataDir, 'recorded', `master-${day.masterId}.json`)));
      const masterRows = masters.get(day.masterId) ?? null;
      if (!masterRows) continue;
      const rows = fromColumns(day.snapshot);
      add({
        docId: `summary:${date}`, sourceType: 'summary', sourceRef: `recorded/${date}.json`, title: `Pre-open summary, ${date}`, kind: 'market',
        tradingDate: date, availableAt: iso(day.recordedAt) ?? iso(day.fetchedAt), publishedAt: iso(day.fetchedAt), version: `summary-v${SUMMARY_VERSION}`,
        text: morningSummary({ date, rows, masterRows, marketUpdatedAt: day.marketUpdatedAt }),
      });
      const bhav = readJson(join(dataDir, 'bhav', `${date}.json`));
      if (bhav) {
        add({
          docId: `outcome:${date}`, sourceType: 'outcome', sourceRef: `bhav/${date}.json`, title: `Outcome summary, ${date} (retrospective)`, kind: 'market',
          tradingDate: date, availableAt: istInstant(date, BHAV_READY_TIME).toISOString(), version: `summary-v${SUMMARY_VERSION}`, retrospective: true,
          text: outcomeSummary({ date, rows, masterRows, outcome: unpackDay(bhav) }),
        });
      }
    } catch (error) { errors.push(`recorded ${date}: ${error.message}`); }
  }

  // Completed TV research summaries (optional, off by default; read only, the pipeline is untouched).
  if (config.tvResearch) {
    try {
      const runs = safeJoin(dataDir, 'tv', 'runs');
      for (const date of existsSync(runs) ? readdirSync(runs).filter((d) => DATE.test(d)).sort() : []) {
        const run = readJson(safeJoin(runs, date, 'run.json'));
        const file = safeJoin(runs, date, 'consensus.md');
        if (run?.status !== 'completed' || !existsSync(file)) continue;
        add({
          docId: `tv:${date}`, sourceType: 'tv', sourceRef: `tv research ${date} (consensus.md)`, title: `TV research consensus, ${date} evening`, kind: 'market',
          tradingDate: date, availableAt: iso(run.finishedAt), publishedAt: iso(run.finishedAt), version: 'tv-consensus', text: readFileSync(file, 'utf8'),
        });
      }
    } catch (error) { errors.push(`tv research: ${error.message}`); }
  }
  return { docs, errors };
}
