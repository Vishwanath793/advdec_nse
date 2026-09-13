import cron from 'node-cron';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { indiaDate, marketDay, nextMarketRun, parseDate, readCalendar, searches, TIMEZONE } from './calendar.js';
import { createBrowserWorker, validateTranscript } from './browser.js';
import { analyzeTranscripts } from './analysis.js';
import { EXTRACTION_PROMPT, CONSENSUS_PROMPT } from './prompts.js';

const json = file => JSON.parse(readFileSync(file, 'utf8'));
const atomic = (file, data) => { writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); renameSync(`${file}.tmp`, file); };
export function createTvService({ root, schedule = cron.schedule, now = () => new Date(), calendar = readCalendar,
  browserFactory = createBrowserWorker, analyze = analyzeTranscripts, keyReady = () => !!process.env.OPENAI_API_KEY } = {}) {
  mkdirSync(join(root, 'runs'), { recursive: true });
  const stateFile = join(root, 'state.json');
  let state = existsSync(stateFile) ? json(stateFile) : { enabled: true, lastRun: null };
  let running = null;
  let task;
  const runPath = date => join(root, 'runs', date);
  const load = date => existsSync(join(runPath(date), 'run.json')) ? json(join(runPath(date), 'run.json')) : null;
  const saveState = () => atomic(stateFile, state);
  function status() {
    const today = indiaDate(now());
    return { ...state, running: !!running, today, market: marketDay(today, calendar()),
      nextRun: state.enabled ? nextMarketRun(now(), calendar()) : null, timezone: TIMEZONE, time: '19:00',
      apiKeyConfigured: keyReady(), model: process.env.OPENAI_MODEL || 'gpt-4.1',
      searches: searches(today), prompts: [EXTRACTION_PROMPT, CONSENSUS_PROMPT],
      history: readdirSync(join(root, 'runs')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 60).map(load).filter(Boolean),
    };
  }
  async function execute(date, trigger) {
    const day = marketDay(date, calendar());
    if (!day.open) return { date, status: 'skipped', reason: day.reason };
    const dir = runPath(date);
    mkdirSync(dir, { recursive: true });
    const previous = load(date);
    if (previous?.status === 'completed') return previous;
    const lockPath = join(root, 'run.lock');
    let lock;
    try { lock = openSync(lockPath, 'wx'); writeFileSync(lock, String(process.pid)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Another TV research process is running.');
      unlinkSync(lockPath);
      lock = openSync(lockPath, 'wx'); writeFileSync(lock, String(process.pid));
    }
    let run = { ...previous, date, status: 'running', stage: 'Starting', trigger, error: null,
      attempts: (previous?.attempts || 0) + 1, startedAt: now().toISOString(), sources: previous?.sources || [] };
    const save = () => { atomic(join(dir, 'run.json'), run); state.lastRun = date; saveState(); };
    let browser;
    try {
      save();
      if (!keyReady()) throw new Error('Set OPENAI_API_KEY in the backend .env file and restart the backend to enable analysis.');
      const transcripts = [];
      for (const show of searches(date)) {
        const filename = `${show.id}.txt`;
        const path = join(dir, filename);
        let source = run.sources.find(s => s.showId === show.id);
        if (!source || !existsSync(path)) {
          browser ||= await browserFactory(root);
          run.stage = `Finding ${show.name}`; save();
          const video = await browser.discover(show, date);
          run.stage = `Downloading ${show.name} captions`; save();
          const download = await browser.download(video, path);
          source = { showId: show.id, name: show.name, searchUrl: show.url, video, ...download, filename,
            sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), bytes: readFileSync(path).length };
          run.sources = [...run.sources.filter(s => s.showId !== show.id), source]; save();
        }
        const bytes = readFileSync(path);
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Transcript integrity check failed for ${filename}.`);
        transcripts.push({ filename, show: show.name, url: source.video.url, text: validateTranscript(bytes.toString('utf8')) });
      }
      await browser?.close(); browser = null;
      run.stage = 'Reading both complete transcripts'; save();
      await analyze(transcripts, async (kind, text, usage) => {
        writeFileSync(join(dir, `${kind}.md`), text);
        run[kind] = text; run[`${kind}Usage`] = usage;
        run.stage = kind === 'extraction' ? 'Comparing distinct analysts' : 'Complete'; save();
      }, undefined, run.extraction || null);
      run.status = 'completed'; run.finishedAt = now().toISOString(); save();
      return run;
    } catch (error) {
      run.status = 'failed'; run.error = error.message; run.finishedAt = now().toISOString();
      await browser?.diagnostic(dir).catch(() => {}); save();
      return run;
    } finally {
      await browser?.close().catch(() => {});
      closeSync(lock); unlinkSync(lockPath);
    }
  }
  function run(date = indiaDate(now()), trigger = 'manual') {
    parseDate(date);
    if (date > indiaDate(now())) throw new Error('Cannot run a future broadcast date.');
    if (running) return running;
    running = execute(date, trigger).finally(() => { running = null; });
    return running;
  }
  async function tick() {
    if (!state.enabled || running) return;
    const date = indiaDate(now());
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now());
    if (time < '19:00' || time > '23:00' || !marketDay(date, calendar()).open) return;
    const previous = load(date);
    if (previous?.status === 'completed' || (previous?.attempts || 0) >= 4) return;
    if (previous?.finishedAt && +now() - +new Date(previous.finishedAt) < 30 * 60_000) return;
    await run(date, 'scheduled');
  }
  saveState();
  // Minute ticks provide same-evening catch-up after restart and bounded 30-minute retries.
  task = schedule('* * * * *', () => tick().catch(console.error), { timezone: TIMEZONE, noOverlap: true, name: 'tv-research' });
  return { status, run, tick, load,
    update(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
      state.enabled = enabled; saveState(); return status();
    },
    artifact(date, filename) {
      parseDate(date);
      if (!['zee.txt', 'cnbc.txt', 'extraction.md', 'consensus.md', 'browser-error.png'].includes(filename)) throw new Error('Unknown artifact.');
      const file = join(runPath(date), filename);
      if (!existsSync(file)) throw new Error('Artifact not available.');
      return file;
    },
    close: () => task.destroy(),
  };
}
