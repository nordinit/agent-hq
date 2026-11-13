import fs from 'fs';
import os from 'os';
import path from 'path';
import { dependencyPins } from './dependencies';

describe('dependencyPins', () => {
  let dir: string;
  let originalCwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-pins-'));
    originalCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pins lockfiles in the executable’s own directory', () => {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    const pins = dependencyPins({ cwd: dir, command: 'node', args: [] });
    expect(pins.map((pin) => pin.path)).toContain(fs.realpathSync(path.join(dir, 'package-lock.json')));
  });

  it('does not pin the API’s own directory for a profile without one', () => {
    // The API runs from its release directory, which moves on every deploy. Pinning its lockfile
    // made every workflow setup profile stale after each release.
    const release = path.join(dir, 'release-a', 'api');
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(release, 'package-lock.json'), '{"lockfileVersion":3}');
    process.chdir(release);
    const workflowSetup = { repo_url: 'git@example.com:org/repo.git', repo_path: null, repo_access_mode: 'clone', environment_setup: { mode: 'off' } };
    expect(dependencyPins(workflowSetup)).toEqual([]);
  });
});
