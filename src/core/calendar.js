/**
 * NSE trading-calendar helpers shared by the Node backend and the Android app.
 * `calendar` is the parsed server/tv/holidays.json ({ years: { YYYY: { holidays } } }).
 */

export const TIMEZONE = 'Asia/Kolkata';

/** Calendar date (YYYY-MM-DD) in India for an instant. */
export function indiaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function parseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD.');
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid date.');
  return parsed;
}

/** Whether NSE equities trade on `date`. Years missing from the calendar fail closed. */
export function marketDay(date, calendar) {
  const d = parseDate(date);
  if ([0, 6].includes(d.getUTCDay())) return { open: false, reason: 'Weekend' };
  const year = calendar.years[date.slice(0, 4)];
  if (!year) return { open: false, reason: `Holiday calendar missing for ${date.slice(0, 4)}; add the official NSE equity calendar first.` };
  return year.holidays[date] ? { open: false, reason: year.holidays[date] } : { open: true, reason: 'NSE equity trading day' };
}

/** The `count` most recent NSE trading days strictly before `today` (YYYY-MM-DD), newest first. */
export function previousTradingDays(today, count, calendar) {
  const days = [];
  const d = new Date(`${today}T12:00:00Z`);
  for (let i = 0; i < 120 && days.length < count; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    if (marketDay(iso, calendar).open) days.push(iso);
  }
  return days;
}

/** The instant of `time` (HH:mm) IST on `date` (YYYY-MM-DD). */
export const istInstant = (date, time) => new Date(`${date}T${time}:00+05:30`);

/** Upcoming trading-day instants at `time` IST strictly after `now` (up to `count`). */
export function upcomingTradingRuns(now, time, calendar, count = 1) {
  const runs = [];
  const d = new Date(`${indiaDate(now)}T12:00:00Z`);
  for (let i = 0; i < 400 && runs.length < count; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (!calendar.years[iso.slice(0, 4)]) break;
    const run = istInstant(iso, time);
    if (+run > +now && marketDay(iso, calendar).open) runs.push(run);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return runs;
}
