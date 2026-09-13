import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
const context = await chromium.launchPersistentContext(fileURLToPath(new URL('../../.data/tv/browser-profile', import.meta.url)), {
  headless: false, locale: 'en-IN', timezoneId: 'Asia/Kolkata',
  ...(process.env.TV_BROWSER_CHANNEL ? { channel: process.env.TV_BROWSER_CHANNEL } : {}),
});
console.log('Complete any Downsub verification yourself, then close this browser before running research. No challenge is solved automatically.');
const page = context.pages()[0] || await context.newPage();
await page.goto('https://downsub.com/', { waitUntil: 'domcontentloaded' });
await new Promise(resolve => context.on('close', resolve));
