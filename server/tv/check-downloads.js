// Live integration check: downloads real captions without calling the paid API.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searches, parseDate } from './calendar.js';
import { createBrowserWorker } from './browser.js';
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
const date = process.argv[2];
parseDate(date);
const root = fileURLToPath(new URL('../../.data/tv', import.meta.url));
const dir = join(root, 'download-checks', date);
mkdirSync(dir, { recursive: true });
const worker = await createBrowserWorker(root);
try {
  const results = [];
  for (const show of searches(date)) {
    console.log(`Searching ${show.name}…`);
    const video = await worker.discover(show, date);
    console.log(`${video.title} (${video.duration})`);
    const filename = join(dir, `${show.id}.txt`);
    const download = await worker.download(video, filename);
    results.push({ show: show.name, video, ...download, filename, bytes: readFileSync(filename).length });
    console.log(`Saved ${show.id}.txt`);
  }
  writeFileSync(join(dir, 'sources.json'), JSON.stringify(results, null, 2));
} catch (error) {
  await worker.diagnostic(dir);
  console.error(error.message); process.exitCode = 1;
} finally { await worker.close(); }
