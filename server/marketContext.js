import { createMarketContextService as createCoreService } from '../src/core/marketContext.js';
import { fsStore } from './fsStore.js';
import { readCalendar } from './tv/calendar.js';

// Logic is shared with the Android app; the backend caches under `dir` on disk.
export {
  historyStats, parseBhavcopy, parseExDates, parseNseDate, parseResults, parseResultsDue, previousTradingDays,
} from '../src/core/marketContext.js';

export function createMarketContextService({ dir, fetchImpl = fetch, now = () => new Date(), calendar = readCalendar() }) {
  return createCoreService({ store: fsStore(dir), fetchImpl, now, calendar });
}
