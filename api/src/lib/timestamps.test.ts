import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  CANONICAL_TIMESTAMP_PATTERN,
  CANONICAL_TIMESTAMP_SQL,
  isCanonicalTimestamp,
  isCanonicalTimestampLoose,
  nowTimestamp,
  parseTimestamp,
  timestampFromDate,
  timestampFromEpochMs,
  toCanonicalTimestamp,
  toCanonicalTimestampOrNow,
  toIsoUtc,
} from './timestamps';

describe('nowTimestamp emits exactly one format', () => {
  it('always matches the canonical pattern, across many samples', () => {
    const samples = Array.from({ length: 2000 }, () => nowTimestamp());
    const shapes = new Set(samples.map((s) => s.replace(/\d/g, 'N')));

    expect(shapes.size).toBe(1);
    expect([...shapes][0]).toBe('NNNN-NN-NN NN:NN:NN');
    for (const s of samples) {
      expect(s).toMatch(CANONICAL_TIMESTAMP_PATTERN);
      expect(isCanonicalTimestamp(s)).toBe(true);
    }
  });

  it('never emits a timezone designator or fractional seconds', () => {
    for (let i = 0; i < 500; i += 1) {
      const s = nowTimestamp();
      expect(s).not.toContain('T');
      expect(s).not.toContain('Z');
      expect(s).not.toContain('.');
      expect(s).not.toMatch(/[+-]\d{2}:?\d{2}$/);
      expect(s).toHaveLength(19);
    }
  });

  it('is byte-identical in shape to what SQLite datetime(\'now\') produces', async () => {
    const db = new Database(':memory:');
    try {
      const sqlNow = await db.get(`SELECT ${CANONICAL_TIMESTAMP_SQL} AS v`) as { v: string };
      const jsNow = nowTimestamp();

      expect(sqlNow.v).toMatch(CANONICAL_TIMESTAMP_PATTERN);
      expect(jsNow).toMatch(CANONICAL_TIMESTAMP_PATTERN);
      expect(jsNow.length).toBe(sqlNow.v.length);
      expect(jsNow.replace(/\d/g, 'N')).toBe(sqlNow.v.replace(/\d/g, 'N'));

      // Same instant to within a couple of seconds — proves nowTimestamp() is
      // UTC and not local (this host is UTC-4, so a local-time bug shows as a
      // ~4h delta).
      const delta = Math.abs(
        parseTimestamp(jsNow)!.getTime() - parseTimestamp(sqlNow.v)!.getTime(),
      );
      expect(delta).toBeLessThan(5000);
    } finally {
      db.close();
    }
  });

  it('is UTC, not host-local', () => {
    const s = nowTimestamp();
    const asUtc = new Date(`${s.replace(' ', 'T')}Z`).getTime();
    expect(Math.abs(asUtc - Date.now())).toBeLessThan(5000);
  });

  it('agrees with the SQL DEFAULT written into an actual column', async () => {
    const db = new Database(':memory:');
    try {
      await db.exec(`
        CREATE TABLE t (
          id INTEGER PRIMARY KEY,
          from_default TEXT NOT NULL DEFAULT (${CANONICAL_TIMESTAMP_SQL}),
          from_js TEXT NOT NULL
        )
      `);
      for (let i = 0; i < 25; i += 1) {
        await db.run('INSERT INTO t (from_js) VALUES (?)', nowTimestamp());
      }
      const rows = await db.all('SELECT from_default, from_js FROM t') as Array<{
        from_default: string;
        from_js: string;
      }>;
      const allShapes = new Set(
        rows.flatMap((r) => [r.from_default, r.from_js]).map((v) => v.replace(/\d/g, 'N')),
      );
      // The point of the whole exercise: a DEFAULT-written value and a
      // JS-written value are indistinguishable.
      expect(allShapes.size).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('toCanonicalTimestamp', () => {
  it('passes canonical values through unchanged', () => {
    expect(toCanonicalTimestamp('2026-06-03 20:05:53')).toBe('2026-06-03 20:05:53');
  });

  it('converts ISO-Z without shifting the instant', () => {
    expect(toCanonicalTimestamp('2026-06-03T20:05:53.000Z')).toBe('2026-06-03 20:05:53.000');
    expect(toCanonicalTimestamp('2026-06-03T20:05:53Z')).toBe('2026-06-03 20:05:53');
  });

  it('truncates fractional seconds when asked', () => {
    expect(
      toCanonicalTimestamp('2026-06-03T20:05:53.472Z', { preserveFractional: false }),
    ).toBe('2026-06-03 20:05:53');
  });

  it('shifts numeric offsets to UTC (the sprints.started_at case)', () => {
    // Real production value from sprints.started_at.
    expect(toCanonicalTimestamp('2026-07-06T11:55:00-04:00')).toBe('2026-07-06 15:55:00');
    expect(toCanonicalTimestamp('2026-07-06T11:55:00+02:00')).toBe('2026-07-06 09:55:00');
    expect(toCanonicalTimestamp('2026-07-06T11:55:00-0400')).toBe('2026-07-06 15:55:00');
  });

  it('treats an offset-less "T" value as UTC, not local', () => {
    expect(toCanonicalTimestamp('2026-06-03T20:05:53')).toBe('2026-06-03 20:05:53');
  });

  it('expands a date-only value to midnight UTC (the sprints.started_at case)', () => {
    expect(toCanonicalTimestamp('2026-03-09')).toBe('2026-03-09 00:00:00');
  });

  it('handles minute precision', () => {
    expect(toCanonicalTimestamp('2026-05-21T04:29Z')).toBe('2026-05-21 04:29:00');
  });

  it('accepts Date and epoch-ms input', () => {
    const d = new Date('2026-06-03T20:05:53.000Z');
    expect(toCanonicalTimestamp(d)).toBe('2026-06-03 20:05:53');
    expect(toCanonicalTimestamp(d.getTime())).toBe('2026-06-03 20:05:53');
    expect(timestampFromDate(d)).toBe('2026-06-03 20:05:53');
    expect(timestampFromEpochMs(d.getTime())).toBe('2026-06-03 20:05:53');
  });

  it('returns null rather than guessing', () => {
    for (const bad of [null, undefined, '', '   ', 'not-a-date', 'now', {}, NaN, new Date(NaN)]) {
      expect(toCanonicalTimestamp(bad as unknown)).toBeNull();
    }
    expect(timestampFromDate(new Date(NaN))).toBeNull();
    expect(timestampFromEpochMs(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(toCanonicalTimestamp('2026-02-31T00:00:00Z')).toBeNull();
  });

  it('is idempotent', () => {
    const inputs = [
      '2026-06-03 20:05:53',
      '2026-06-03T20:05:53.000Z',
      '2026-07-06T11:55:00-04:00',
      '2026-03-09',
      '2026-05-21T04:29Z',
    ];
    for (const input of inputs) {
      const once = toCanonicalTimestamp(input)!;
      expect(toCanonicalTimestamp(once)).toBe(once);
      expect(isCanonicalTimestampLoose(once)).toBe(true);
    }
  });

  it('every normalized production-shaped value lands in exactly one format', () => {
    const productionShapes = [
      '2026-06-03 20:05:53',
      '2026-06-03T20:05:53.000Z',
      '2026-06-03T20:05:53Z',
      '2026-07-06T11:55:00-04:00',
      '2026-05-21T04:29:00Z',
      '2026-03-09',
    ];
    const normalized = productionShapes.map(
      (v) => toCanonicalTimestamp(v, { preserveFractional: false })!,
    );
    const shapes = new Set(normalized.map((v) => v.replace(/\d/g, 'N')));
    expect(shapes.size).toBe(1);
    expect([...shapes][0]).toBe('NNNN-NN-NN NN:NN:NN');
  });

  it('normalized values sort identically to their true chronological order', () => {
    const chronological = [
      '2026-06-03T20:05:53.000Z',
      '2026-07-06T11:55:00-04:00', // 15:55:00Z
      '2026-07-06T16:00:00Z',
      '2026-07-06 17:00:00',
    ];
    const normalized = chronological.map(
      (v) => toCanonicalTimestamp(v, { preserveFractional: false })!,
    );
    expect([...normalized].sort()).toEqual(normalized);
  });
});

describe('round-tripping', () => {
  it('parseTimestamp reads canonical values as UTC', () => {
    expect(parseTimestamp('2026-06-03 20:05:53')!.toISOString()).toBe('2026-06-03T20:05:53.000Z');
    expect(parseTimestamp('2026-06-03T20:05:53Z')!.toISOString()).toBe('2026-06-03T20:05:53.000Z');
    expect(parseTimestamp('garbage')).toBeNull();
  });

  it('toIsoUtc renders canonical storage as ISO-Z for API responses', () => {
    expect(toIsoUtc('2026-06-03 20:05:53')).toBe('2026-06-03T20:05:53.000Z');
    expect(toIsoUtc('2026-07-06T11:55:00-04:00')).toBe('2026-07-06T15:55:00.000Z');
    expect(toIsoUtc(null)).toBeNull();
  });

  it('toCanonicalTimestampOrNow falls back to now only for unusable input', () => {
    expect(toCanonicalTimestampOrNow('2026-06-03T20:05:53Z')).toBe('2026-06-03 20:05:53');
    expect(toCanonicalTimestampOrNow(null)).toMatch(CANONICAL_TIMESTAMP_PATTERN);
    expect(toCanonicalTimestampOrNow('nonsense')).toMatch(CANONICAL_TIMESTAMP_PATTERN);
  });
});

describe('the migration hazard this helper exists to prevent', () => {
  it('a naive value cast as local time is off by the host offset; canonical is not', () => {
    const stored = '2026-06-03 20:05:53';
    const correct = parseTimestamp(stored)!.getTime(); // treated as UTC
    const buggyLocal = new Date('2026-06-03T20:05:53').getTime(); // treated as local
    const hostOffsetMs = new Date('2026-06-03T20:05:53Z').getTimezoneOffset() * 60_000;

    // Only meaningful when the test host is not UTC; assert the relationship
    // rather than a hard-coded 4h so this passes in CI too.
    expect(buggyLocal - correct).toBe(hostOffsetMs);
    expect(toCanonicalTimestamp(stored)).toBe(stored);
  });
});

describe('scripts/normalize-timestamps.mjs stays in sync with this module', () => {
  // The migration script cannot import TypeScript, so it carries its own copy of
  // the normalizer. If the two ever diverge, freshly-written rows and
  // freshly-normalized rows stop matching. This test is the tripwire.
  //
  // The script is ESM and Jest runs CJS here, so it is exercised in a subprocess.
  const CORPUS: unknown[] = [
    '2026-06-03 20:05:53',
    '2026-06-03 20:05:53.472',
    '2026-06-03T20:05:53.000Z',
    '2026-06-03T20:05:53Z',
    '2026-06-03T20:05:53',
    '2026-07-06T11:55:00-04:00',
    '2026-07-06T11:55:00+02:00',
    '2026-07-06T11:55:00-0400',
    '2026-05-21T04:29Z',
    '2026-03-09',
    '2026-02-31T00:00:00Z',
    'not-a-date',
    '',
    '   ',
    null,
  ];

  it('produces identical output for every encoding seen in production', () => {
    const scriptPath = path.resolve(__dirname, '../../../scripts/normalize-timestamps.mjs');
    expect(fs.existsSync(scriptPath)).toBe(true);

    const program = `
      import { toCanonicalTimestamp } from ${JSON.stringify(scriptPath)};
      const corpus = ${JSON.stringify(CORPUS)};
      console.log(JSON.stringify({
        keep: corpus.map((v) => toCanonicalTimestamp(v)),
        drop: corpus.map((v) => toCanonicalTimestamp(v, { preserveFractional: false })),
      }));
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    const fromScript = JSON.parse(res.stdout.trim()) as {
      keep: Array<string | null>;
      drop: Array<string | null>;
    };

    expect(fromScript.keep).toEqual(CORPUS.map((v) => toCanonicalTimestamp(v)));
    expect(fromScript.drop).toEqual(
      CORPUS.map((v) => toCanonicalTimestamp(v, { preserveFractional: false })),
    );
  });
});
