import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  ForeignKeyEnforcementDisabledError,
  assertForeignKeyEnforcementEnabled,
} from './startupVerifier';
import { type Db } from "./adapter/types";

let db: Db;
let errorSpy: ReturnType<typeof jest.spyOn>;

const fkState = (): number => Number(db.pragma('foreign_keys', { simple: true }));

beforeEach(() => {
  db = new Database(':memory:');
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  db.close();
});

describe('assertForeignKeyEnforcementEnabled', () => {
  it('passes silently when enforcement is on', () => {
    db.pragma('foreign_keys = ON');

    expect(assertForeignKeyEnforcementEnabled(db, 'test')).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws a typed error and logs unmissably when enforcement leaked off', () => {
    db.pragma('foreign_keys = OFF');

    expect(() => assertForeignKeyEnforcementEnabled(db, 'test migrations'))
      .toThrow(ForeignKeyEnforcementDisabledError);
    const logged = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(logged).toContain('FATAL DATA INTEGRITY DEFECT');
    expect(logged).toContain('test migrations');
  });

  it('can report without throwing, for request-path callers', () => {
    db.pragma('foreign_keys = OFF');

    expect(assertForeignKeyEnforcementEnabled(db, 'test', { throwOnViolation: false })).toBe(false);
    expect(fkState()).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('force-restores enforcement when asked to', () => {
    db.pragma('foreign_keys = OFF');

    expect(assertForeignKeyEnforcementEnabled(db, 'test', { throwOnViolation: false, restore: true }))
      .toBe(false);
    expect(fkState()).toBe(1);
    const logged = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(logged).toContain('force-restored');
  });
});
