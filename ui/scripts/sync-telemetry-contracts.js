/* API definitions are canonical. Commit these generated browser-safe copies so the UI
 * remains buildable from its independent Docker context (which contains only ui/).
 * Run from any directory: node ui/scripts/sync-telemetry-contracts.js [--check]
 */
const fs = require('node:fs');
const path = require('node:path');
const sourceDir = path.resolve(__dirname, '../../api/src/domains/telemetry');
const outputDir = path.resolve(__dirname, '../lib/telemetry-contracts');
const header = '// Generated from api/src/domains/telemetry; run node ui/scripts/sync-telemetry-contracts.js.\n';
function generated(name) { return header + fs.readFileSync(path.join(sourceDir, name), 'utf8'); }
function sync(check) {
  for (const name of ['contracts.ts', 'recipes.ts']) {
    const expected = generated(name); const destination = path.join(outputDir, name);
    if (check) {
      if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== expected) throw new Error(`Generated telemetry ${name} is stale. Run node ui/scripts/sync-telemetry-contracts.js.`);
    } else { fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(destination, expected); }
  }
}
if (require.main === module) sync(process.argv.includes('--check'));
module.exports = { sync, sourceDir };
