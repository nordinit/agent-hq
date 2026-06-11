import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInitialProjectFilter } from './projectFilterPreference.ts';

function withMockWindow(search: string, storedValue: string | null, fn: () => void) {
  const previousWindow = globalThis.window;
  const storage = new Map<string, string>();
  if (storedValue !== null) storage.set('agent-hq:last-project-filter', storedValue);

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { search },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  });

  try {
    fn();
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      });
    }
  }
}

test('resolveInitialProjectFilter restores the stored project before fallback all-project state', () => {
  withMockWindow('', '7', () => {
    assert.deepEqual(resolveInitialProjectFilter(null), { projectId: 7, source: 'stored' });
  });
});

test('resolveInitialProjectFilter lets explicit URL project_id override stored preference', () => {
  withMockWindow('?project_id=11', '7', () => {
    assert.deepEqual(resolveInitialProjectFilter(null), { projectId: 11, source: 'explicit' });
  });
});

test('resolveInitialProjectFilter preserves explicit All Projects selection', () => {
  withMockWindow('?project_id=all', '7', () => {
    assert.deepEqual(resolveInitialProjectFilter(3), { projectId: null, source: 'explicit' });
  });
});
