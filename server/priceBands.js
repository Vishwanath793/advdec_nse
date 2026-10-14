import { basename, dirname } from 'node:path';
import { createPriceBandService as createCoreService, parseSecList, SEC_LIST_URL } from '../src/core/priceBands.js';
import { fsStore } from './fsStore.js';

// Logic is shared with the Android app; the backend caches to `file` on disk.
export { parseSecList, SEC_LIST_URL };

export function createPriceBandService({ file, fetchImpl = fetch, now = () => new Date() }) {
  return createCoreService({ store: fsStore(dirname(file)), name: basename(file), fetchImpl, now });
}
