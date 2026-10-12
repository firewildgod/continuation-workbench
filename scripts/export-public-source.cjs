// Create a clean sibling checkout using only reviewed sources. Existing files are never removed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { publicSourcePlan } = require('./public-source-plan.cjs');
const { checkPublicSource } = require('./check-public-source.cjs');

function exportPublicSource(projectRoot = path.resolve(__dirname, '..'), destination) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(destination || path.join(root, '..', 'continuation-workbench-public'));
  assert.ok(path.dirname(target) === path.dirname(root) && target !== root, 'Public export must be a separate sibling directory.');
  assert.equal(fs.lstatSync(path.dirname(target)).isSymbolicLink(), false, 'Export parent cannot be a link.');
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Export destination must be a regular directory.');
    assert.equal(fs.readdirSync(target).length, 0, 'Use a fresh empty destination; an existing checkout is never overwritten.');
  }
  const check = checkPublicSource(root);
  const plan = publicSourcePlan(root);
  // Active workflows are intentionally omitted from the initial publication; templates remain in docs.
  const published = plan.filter(item => !item.relative.startsWith('.github/'));
  fs.mkdirSync(target, { recursive: true });
  for (const { relative, source } of published) {
    const output = path.join(target, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
    const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    assert.equal(digest(source), digest(output), `Export hash mismatch: ${relative}`);
  }
  const result = checkPublicSource(target);
  return { destination: target, copiedFiles: published.length, sourceCheck: check, exportCheck: result, privateDataIncluded: false };
}

module.exports = { exportPublicSource };
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(exportPublicSource(undefined, process.argv[2])) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
