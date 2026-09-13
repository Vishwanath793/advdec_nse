import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDate } from './calendar.js';

export function durationSeconds(text) {
  // YouTube renders the same time twice (visual label plus accessibility text).
  const labels = [...new Set(String(text).trim().split(/\s+/))];
  if (labels.length !== 1) return 0;
  const m = labels[0].match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const parts = m.slice(1).filter(x => x !== undefined).map(Number);
  if (parts.slice(1).some(x => x > 59)) return 0;
  return parts.reduce((a, b) => a * 60 + b, 0);
}
export function matchesDate(title, date) {
  const d = parseDate(date);
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = d.getUTCDate();
  const pattern = new RegExp(`\\b0?${day}(?:st|nd|rd|th)?[\\s,./-]+(?:${month}|${month.slice(0, 3)}${month === 'September' ? '|Sept' : ''})[\\s,./-]+${d.getUTCFullYear()}\\b`, 'i');
  return pattern.test(title);
}
export function selectVideo(candidates, show, date) {
  return candidates.find(v => v.seconds >= 7 * 3600 && !v.live && matchesDate(v.title, date)
    && (show.id === 'zee' ? /zee\s*business/i : /cnbc\s*awaaz/i).test(v.channel)
    && (show.id === 'zee' ? /first\s*trade/i : /anuj\s*singhal/i).test(v.title));
}
export function downsubUrl(videoUrl) {
  return `https://downsub.com/?url=${encodeURIComponent(videoUrl)}`;
}
export function validateTranscript(text) {
  if (text.trim().length < 1000 || /<!doctype|<html|<body/i.test(text) || text.includes('\u0000')) {
    throw new Error('Downloaded TXT is empty, too short for a full broadcast, or contains an HTML/error page.');
  }
  return text;
}
export async function createBrowserWorker(root) {
  const context = await chromium.launchPersistentContext(join(root, 'browser-profile'), {
    headless: process.env.TV_BROWSER_HEADLESS !== 'false', acceptDownloads: true,
    ...(process.env.TV_BROWSER_CHANNEL ? { channel: process.env.TV_BROWSER_CHANNEL } : {}),
    locale: 'en-IN', timezoneId: 'Asia/Kolkata',
  });
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  // Prevent ad popups from collecting unbounded tabs.
  context.on('page', p => { if (p !== page) p.close().catch(() => {}); });
  async function discover(show, date) {
    await page.goto(show.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const consent = page.getByRole('button', { name: /Reject all/i });
    if (await consent.isVisible()) await consent.click();
    await page.locator('ytd-video-renderer').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('ytd-video-renderer #video-title')].some(el => el.textContent.trim()), null, { timeout: 30_000 });
    for (let batch = 0; batch < 6; batch++) {
      const rows = await page.locator('ytd-video-renderer').evaluateAll(nodes => nodes.map(node => ({
        title: node.querySelector('#video-title')?.textContent?.trim() || '',
        href: node.querySelector('a#video-title')?.href || '',
        channel: node.querySelector('ytd-channel-name')?.textContent?.trim() || '',
        duration: node.querySelector('ytd-thumbnail-overlay-time-status-renderer')?.textContent?.trim() || '',
        live: !!node.querySelector('[overlay-style="LIVE"]'),
      })));
      const video = selectVideo(rows.map(row => ({ ...row, seconds: durationSeconds(row.duration) })), show, date);
      if (video) {
        const id = new URL(video.href).searchParams.get('v');
        if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Invalid YouTube video ID.');
        return { ...video, url: `https://www.youtube.com/watch?v=${id}`, id };
      }
      const count = rows.length;
      await page.locator('ytd-video-renderer').last().scrollIntoViewIfNeeded();
      await page.waitForFunction(n => document.querySelectorAll('ytd-video-renderer').length > n, count, { timeout: 5000 }).catch(() => {});
    }
    throw new Error(`${show.name}: no completed 7+ hour broadcast with the correct date and channel in the first loaded search results. Retry after the live replay is ready.`);
  }
  async function download(video, target) {
    await page.goto(downsubUrl(video.url), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (/security verification|verify you are human|just a moment/i.test(await page.locator('body').innerText())) {
      throw new Error('Downsub requires human verification. Run npm run tv:setup-browser, complete the check yourself in that browser, close it, and retry. Unattended downloads remain blocked if the challenge returns.');
    }
    const txt = page.locator('button[data-title="[TXT] Hindi (auto-generated)"]');
    // The query URL can start extraction itself. Only submit if no result arrived.
    if (!await txt.first().isVisible()) {
      const submit = page.getByRole('button', { name: 'DOWNLOAD', exact: true });
      await submit.waitFor({ timeout: 30_000 });
      if (await submit.isEnabled()) await submit.click();
    }
    await txt.first().waitFor({ timeout: 120_000 });
    // Verified on the original Hindi track; translated tracks use separate data-title values.
    if (await txt.count() !== 1) throw new Error('Cannot uniquely identify the Hindi (auto-generated) TXT download row.');
    const pending = page.waitForEvent('download', { timeout: 60_000 });
    const [download] = await Promise.all([pending, txt.click()]);
    await download.saveAs(target);
    validateTranscript(readFileSync(target, 'utf8'));
    return { language: 'Hindi (auto-generated)', downsubUrl: downsubUrl(video.url) };
  }
  return {
    discover, download,
    async diagnostic(dir) {
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, 'browser-error.png'), fullPage: true }).catch(() => {});
    },
    close: () => context.close(),
  };
}
