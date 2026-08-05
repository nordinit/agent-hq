import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell } from './migration-csv.mjs';

test('decodes a Buffer stored in a TEXT-affinity column as UTF-8 CSV text', () => {
  const markdown = Buffer.from('---\nname: example\ndescription: "quoted"\n---\n', 'utf8');
  assert.equal(
    csvCell(markdown, 'TEXT', 'skills.content'),
    '"---\nname: example\ndescription: ""quoted""\n---\n"',
  );
});

test('hex-encodes only a declared SQLite BLOB column', () => {
  assert.equal(csvCell(Buffer.from([0x00, 0xff]), 'BLOB', 'artifacts.data'), '"\\x00ff"');
});

test('refuses invalid UTF-8 in a non-BLOB column', () => {
  assert.throws(
    () => csvCell(Buffer.from([0xff]), 'TEXT', 'skills.content'),
    /skills\.content contains non-UTF-8 bytes/,
  );
});

test('preserves CSV null, number, and empty-string distinctions', () => {
  assert.equal(csvCell(null, 'TEXT'), '');
  assert.equal(csvCell(42, 'INTEGER'), '42');
  assert.equal(csvCell('', 'TEXT'), '""');
});
