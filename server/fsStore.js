import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * JSON key/value store on disk for the shared src/core services
 * ({ read(name), write(name, value) }); the Android app has its own.
 */
export function fsStore(dir) {
  return {
    async read(name) {
      try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') console.error(`Cache ${name} unreadable: ${error.message}`);
        return null;
      }
    },
    async write(name, value) {
      const file = join(dir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(value));
      renameSync(`${file}.tmp`, file);
    },
  };
}
