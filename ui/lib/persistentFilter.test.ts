import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  booleanFilter,
  filterStorageKey,
  idFilter,
  idListFilter,
  optionalStringFilter,
  resolveFilterValue,
  stringListFilter,
  withSearchParam,
} from './persistentFilter.ts';

test('the address bar wins over storage, and storage over the default', () => {
  assert.equal(resolveFilterValue('rules', 'graph', 'graph', optionalStringFilter), 'rules');
  assert.equal(resolveFilterValue(null, 'rules', 'graph', optionalStringFilter), 'rules');
  assert.equal(resolveFilterValue(null, null, 'graph', optionalStringFilter), 'graph');
});

test('an unreadable value falls through to the next source', () => {
  // A hand-edited ?workflow_id=abc must not wipe a good stored choice.
  assert.equal(resolveFilterValue('abc', '12', null, idFilter), 12);
  assert.equal(resolveFilterValue('abc', '-3', null, idFilter), null);
  assert.equal(resolveFilterValue('yes', '1', false, booleanFilter), true);
});

test('an explicit "all" in the address bar beats a stored id', () => {
  assert.equal(resolveFilterValue('', '12', null, idFilter), null);
  assert.equal(resolveFilterValue('all', '12', null, idFilter), null);
});

test('id lists round-trip and reject junk', () => {
  assert.deepEqual(idListFilter.parse(idListFilter.serialize([4, 9])), [4, 9]);
  assert.deepEqual(idListFilter.parse(''), []);
  assert.equal(idListFilter.parse('4,x'), undefined);
});

test('string lists round-trip values that contain commas', () => {
  const values = ['review', 'needs a fix, then retest', '__all__'];
  assert.deepEqual(stringListFilter.parse(stringListFilter.serialize(values)), values);
  // An emptied filter is stored as empty text and must read back as no selection, which is
  // how a default such as ['enabled'] is told apart from "show everything".
  assert.deepEqual(stringListFilter.parse(stringListFilter.serialize([])), []);
});

test('setting a parameter keeps the others, and null removes it', () => {
  const href = 'https://mac:3500/routing?project_id=99&trace_task=5#x';
  assert.equal(withSearchParam(href, 'tab', 'rules'), '/routing?project_id=99&trace_task=5&tab=rules#x');
  assert.equal(withSearchParam(href, 'trace_task', null), '/routing?project_id=99#x');
  assert.equal(withSearchParam('https://mac:3500/tasks?q=a', 'q', null), '/tasks');
});

test('storage is keyed per page', () => {
  assert.notEqual(filterStorageKey('/routing', 'task_type'), filterStorageKey('/tasks', 'task_type'));
});
