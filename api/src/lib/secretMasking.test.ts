import { isMaskOf, maskEnvRecord, maskSecret, redactMcpServerRow, restoreMaskedEnvValues } from './secretMasking';

describe('secret masking', () => {
  it('masks a secret without revealing more than a short suffix of a long value', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret(null)).toBe('');
    expect(maskSecret('short-secret')).toBe('********');
    expect(maskSecret('sk-live-0123456789abcdef')).toBe('********cdef');
  });

  it('recognises only the mask of the value it was derived from', () => {
    expect(isMaskOf('********cdef', 'sk-live-0123456789abcdef')).toBe(true);
    expect(isMaskOf('********cdef', 'sk-live-0000000000000000')).toBe(false);
    expect(isMaskOf('********', '')).toBe(false);
    expect(isMaskOf(undefined, 'secret')).toBe(false);
  });

  it('masks environment values and keeps the keys', () => {
    expect(maskEnvRecord('{"API_KEY":"sk-live-0123456789abcdef","MODE":"fast"}')).toEqual({
      API_KEY: '********cdef',
      MODE: '********',
    });
    expect(maskEnvRecord('not json')).toEqual({});
  });

  it('restores masked values on update while taking new and removed keys literally', () => {
    const stored = '{"API_KEY":"sk-live-0123456789abcdef","TOKEN":"tok-1","DROPPED":"x"}';
    expect(restoreMaskedEnvValues(
      { API_KEY: '********cdef', TOKEN: 'tok-2', ADDED: 'new' },
      stored,
    )).toEqual({ API_KEY: 'sk-live-0123456789abcdef', TOKEN: 'tok-2', ADDED: 'new' });
    // A mask that does not match the stored value for that key is not a way to read another key.
    expect(restoreMaskedEnvValues('{"TOKEN":"********cdef"}', stored)).toEqual({ TOKEN: '********cdef' });
  });

  it('redacts server env and assignment override env', () => {
    const row = redactMcpServerRow({
      id: 1,
      command: 'node',
      env: '{"API_KEY":"sk-live-0123456789abcdef"}',
      overrides: '{"env":{"API_KEY":"override-secret"},"toolFilter":{"include":["a"]}}',
    });
    expect(row.env).toBe('{"API_KEY":"********cdef"}');
    expect(JSON.parse(String(row.overrides))).toEqual({ env: { API_KEY: '********' }, toolFilter: { include: ['a'] } });
  });
});
