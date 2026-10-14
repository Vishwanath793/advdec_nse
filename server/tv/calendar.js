import { readFileSync } from 'node:fs';
import { TIMEZONE, indiaDate, marketDay, parseDate } from '../../src/core/calendar.js';

// Shared with the Android app; re-exported for the TV research modules.
export { TIMEZONE, indiaDate, marketDay, parseDate };

export function ordinal(day) {
  return `${day}${day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th')}`;
}
export function searches(date) {
  const d = parseDate(date);
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const short = month === 'September' ? 'Sept' : month.slice(0, 3);
  return [
    { id: 'zee', name: 'Zee Business', query: `zee business live first trade ${ordinal(d.getUTCDate())} ${month.toLowerCase()}` },
    { id: 'cnbc', name: 'CNBC Awaaz', query: `cnbc awaaz Stock Market Updates | Anuj Singhal ${ordinal(d.getUTCDate())} ${short} ${d.getUTCFullYear()}` },
  ].map(s => ({ ...s, url: `https://www.youtube.com/results?${new URLSearchParams({ search_query: s.query })}` }));
}
export const readCalendar = () => JSON.parse(readFileSync(new URL('./holidays.json', import.meta.url), 'utf8'));
export function nextMarketRun(now, calendar) {
  const d = parseDate(indiaDate(now));
  for (let i = 0; i < 370; i++) {
    const date = d.toISOString().slice(0, 10);
    if (!calendar.years[date.slice(0, 4)]) return null;
    const run = new Date(`${date}T19:00:00+05:30`);
    if (+run > +now && marketDay(date, calendar).open) return run.toISOString();
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}
