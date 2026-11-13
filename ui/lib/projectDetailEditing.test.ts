import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const page = readFileSync(path.resolve(import.meta.dirname, '..', 'app/projects/[id]/page.tsx'), 'utf8');

test('the project context box is never a read-only editor that ignores typing', () => {
  // It used to render readOnly until the header Edit button was pressed, so its own Edit tab
  // showed an editor with no cursor and dropped every keystroke.
  assert.doesNotMatch(page, /readOnly=\{!editing\}/);
  assert.doesNotMatch(page, /onChange=\{e => editing && setEditContext/);
  assert.match(page, /onFocus=\{startEditing\}/);
  assert.match(page, /onChange=\{e => \{ startEditing\(\); setEditContext\(e\.target\.value\); \}\}/);
});

test('the context Edit tab, the description and the header button all start editing', () => {
  assert.match(page, /onClick=\{\(\) => \{ setContextTab\('edit'\); startEditing\(\); \}\}/);
  assert.match(page, /<button\s+type="button"\s+onClick=\{startEditing\}[\s\S]*?No description\. Click to add one\./);
  assert.match(page, /<Button variant="ghost" size="sm" onClick=\{startEditing\}>/);
});
