const fs = require('fs');
const path = require('path');

function sameResolvedTarget(targetPath, sourcePath) {
  try {
    return fs.realpathSync(targetPath) === fs.realpathSync(sourcePath);
  } catch {
    return false;
  }
}

function copyDirectory(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  console.log('[standalone] Copied static assets:', targetDir, '<-', sourceDir);
}

function ensureDirectoryMirror(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    const existing = fs.lstatSync(targetDir);
    if (existing.isSymbolicLink() || sameResolvedTarget(targetDir, sourceDir)) {
      const existingTarget = existing.isSymbolicLink()
        ? path.resolve(path.dirname(targetDir), fs.readlinkSync(targetDir))
        : sourceDir;
      if (sameResolvedTarget(existingTarget, sourceDir)) {
        return;
      }
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  } catch {
    // No existing target to replace.
  }

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(sourceDir, targetDir, symlinkType);
    console.log('[standalone] Linked static assets:', targetDir, '->', sourceDir);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : '';
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'UNKNOWN') {
      throw error;
    }
    copyDirectory(sourceDir, targetDir);
  }
}

function findStandaloneServerDirs(standaloneRoot) {
  const dirs = new Set();
  const direct = path.join(standaloneRoot, 'server.js');
  if (fs.existsSync(direct)) {
    dirs.add(path.dirname(direct));
  }

  const stack = [standaloneRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === 'server.js') {
        dirs.add(path.dirname(entryPath));
      } else if (entry.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }

  if (dirs.size === 0) {
    dirs.add(standaloneRoot);
  }
  return Array.from(dirs);
}

function ensureStandaloneStatic() {
  const uiRoot = path.resolve(__dirname, '..');
  const standaloneRoot = path.join(uiRoot, '.next', 'standalone');
  const sourceStaticDir = path.join(uiRoot, '.next', 'static');
  const sourcePublicDir = path.join(uiRoot, 'public');

  if (!fs.existsSync(sourceStaticDir)) {
    console.warn('[standalone] Source static directory not found:', sourceStaticDir);
    return;
  }

  const serverDirs = findStandaloneServerDirs(standaloneRoot);
  for (const serverDir of serverDirs) {
    ensureDirectoryMirror(sourceStaticDir, path.join(serverDir, '.next', 'static'));
    if (fs.existsSync(sourcePublicDir)) {
      ensureDirectoryMirror(sourcePublicDir, path.join(serverDir, 'public'));
    }
  }
}

if (require.main === module) {
  ensureStandaloneStatic();
}

module.exports = { ensureStandaloneStatic };
