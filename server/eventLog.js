import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An append-only NDJSON event log, one file per day: <dir>/YYYY-MM-DD.ndjson.
 * Lines are only ever appended (synchronously, so the order is the order of
 * events); nothing rewrites or deletes them. Used for the paper-trading ledger.
 */
export function createEventLog(dir) {
  const file = (date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
    return join(dir, `${date}.ndjson`);
  };
  return {
    append(date, event) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file(date), `${JSON.stringify(event)}\n`);
    },
    /** Every event for `date` (a damaged trailing line is skipped), or [] when there's no log. */
    read(date) {
      const f = file(date);
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    },
    text(date) {
      const f = file(date);
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    },
  };
}
