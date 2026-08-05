const fs = require('fs');
const path = require('path');

function copyDirectory(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  console.log('[standalone] Copied static assets:', targetDir, '<-', sourceDir);
}

function ensureDirectoryMirror(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  // Standalone output is copied into the runtime image without the builder filesystem. Absolute
  // symlinks back into `.next/static` therefore become broken in Docker; materialize the assets.
  copyDirectory(sourceDir, targetDir);
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
      } else if (entry.isDirectory() && entry.name !== 'node_modules') {
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
