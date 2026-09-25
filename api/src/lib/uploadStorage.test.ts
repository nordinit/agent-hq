import path from 'path';
import { resolveUploadDirectory, UploadPathError } from './uploadStorage';

describe('resolveUploadDirectory', () => {
  const base = path.resolve('/srv/agent-hq/uploads/projects');

  it('resolves ordinary id segments under the base', () => {
    expect(resolveUploadDirectory(base, '700')).toBe(path.join(base, '700'));
    expect(resolveUploadDirectory(base, '700', '900')).toBe(path.join(base, '700', '900'));
  });

  it('refuses a destination outside the base, or the base itself', () => {
    for (const segments of [['..'], ['../../etc'], ['700', '../../..'], ['/etc'], [''], ['.'], ['..projects-sibling/../..']]) {
      expect(() => resolveUploadDirectory(base, ...segments)).toThrow(UploadPathError);
    }
  });

  it('accepts a directory whose name merely starts with two dots', () => {
    expect(resolveUploadDirectory(base, '..cache')).toBe(path.join(base, '..cache'));
  });
});
