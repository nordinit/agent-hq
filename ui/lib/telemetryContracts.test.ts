import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sync, sourceDir } = require('../scripts/sync-telemetry-contracts.js');

test('the independently deployable UI uses the exact canonical API contracts and recipe factories', { skip: !existsSync(sourceDir) && 'Standalone UI context has no API source to compare.' }, () => {
  sync(true);
});
