import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createTvService } from './service.js';
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
const service = createTvService({ root: fileURLToPath(new URL('../../.data/tv', import.meta.url)), schedule: () => ({ destroy() {} }) });
try {
  const date = process.argv[2];
  const result = await service.run(date, 'cli');
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exitCode = 1;
} finally { service.close(); }
