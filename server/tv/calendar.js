import { readFileSync } from 'node:fs';

export const TIMEZONE = 'Asia/Kolkata';
export function indiaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function parseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD.');
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid date.');
  return parsed;
}
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
export function marketDay(date, calendar) {
  const d = parseDate(date);
  if ([0, 6].includes(d.getUTCDay())) return { open: false, reason: 'Weekend' };
  const year = calendar.years[date.slice(0, 4)];
  if (!year) return { open: false, reason: `Holiday calendar missing for ${date.slice(0, 4)}; add the official NSE equity calendar first.` };
  return year.holidays[date] ? { open: false, reason: year.holidays[date] } : { open: true, reason: 'NSE equity trading day' };
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
