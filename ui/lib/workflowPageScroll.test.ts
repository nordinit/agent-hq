import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, '..', 'components', 'MainContent.tsx'), 'utf8');
const page = readFileSync(join(here, '..', 'app', 'workflows', '[id]', 'page.tsx'), 'utf8');

test('every workflow tab scrolls, although the shell gives workflow pages no scrolling of their own', () => {
  // The shell turns off its own scrolling for full-height pages on wide screens.
  assert.match(shell, /const FULL_HEIGHT_PREFIXES = \['\/workflows\/'\]/);
  assert.match(shell, /'overflow-y-auto md:overflow-hidden'/);
  // So the workflow page scrolls itself on every tab but the board, which scrolls per column.
  assert.match(page, /tab === 'tasks' \? 'md:h-full md:overflow-hidden' : 'min-h-0 flex-1 space-y-6 overflow-y-auto'/);
});
