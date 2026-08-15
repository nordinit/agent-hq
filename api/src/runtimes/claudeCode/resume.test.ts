import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeProjectSlug, claudeSessionTranscriptPath, resolveResumableSessionId } from './resume';

const SESSION_ID = '9278eeca-b7af-44f7-bc1f-2e6d4c16ee09';

describe('claudeProjectSlug', () => {
  it('matches the directory names the CLI actually writes', () => {
    // Verified against ~/.claude/projects on 2026-08-15: separators and dots both
    // collapse to '-', which is why a dotted directory yields a doubled dash.
    expect(claudeProjectSlug('/Users/nordini/agent-hq')).toBe('-Users-nordini-agent-hq');
    expect(claudeProjectSlug('/Users/nordini/.agent-hq/workspaces/atlas'))
      .toBe('-Users-nordini--agent-hq-workspaces-atlas');
  });

  it('normalizes a relative or untidy path before slugifying', () => {
    expect(claudeProjectSlug('/Users/nordini/agent-hq/'))
      .toBe(claudeProjectSlug('/Users/nordini/agent-hq'));
  });
});

describe('resolveResumableSessionId', () => {
  let configHome: string;
  const cwd = '/Users/nordini/agent-hq';

  beforeEach(() => {
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-resume-'));
  });

  afterEach(() => {
    fs.rmSync(configHome, { recursive: true, force: true });
  });

  function writeTranscript(sessionId: string, forCwd = cwd): void {
    const file = claudeSessionTranscriptPath(configHome, forCwd, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  }

  it('resumes a session whose transcript exists for this project', () => {
    writeTranscript(SESSION_ID);
    expect(resolveResumableSessionId({ requested: SESSION_ID, cwd, claudeConfigHome: configHome }))
      .toBe(SESSION_ID);
  });

  it('starts fresh when the transcript is gone', () => {
    // Nothing written — the session was cleaned up since the last turn. Resuming
    // it would fail the dispatch outright, so a cold turn is the better outcome.
    expect(resolveResumableSessionId({ requested: SESSION_ID, cwd, claudeConfigHome: configHome }))
      .toBeNull();
  });

  it('starts fresh when the session belongs to another working directory', () => {
    // `--resume` only reaches sessions of the project it runs in, so an id
    // recorded while the agent pointed elsewhere is not resumable from here.
    writeTranscript(SESSION_ID, '/Users/nordini/some-other-repo');
    expect(resolveResumableSessionId({ requested: SESSION_ID, cwd, claudeConfigHome: configHome }))
      .toBeNull();
  });

  it('ignores anything that is not a session id', () => {
    for (const requested of [null, undefined, '', '   ', 'not-a-uuid', '../../etc/passwd']) {
      expect(resolveResumableSessionId({ requested, cwd, claudeConfigHome: configHome })).toBeNull();
    }
  });

  it('tolerates surrounding whitespace on a real id', () => {
    writeTranscript(SESSION_ID);
    expect(resolveResumableSessionId({ requested: `  ${SESSION_ID}  `, cwd, claudeConfigHome: configHome }))
      .toBe(SESSION_ID);
  });
});
