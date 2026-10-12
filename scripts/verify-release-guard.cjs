// Offline release guard regression check: only fake artifacts and QA-owned files.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepareRelease, publicFilePlan, assertPublicDirectory } = require('./prepare-release.cjs');
const { resolveClaudeCommand } = require('./runtime-paths.cjs');
const qaRoot = path.resolve(__dirname, '../.qa/release-guard');
fs.mkdirSync(qaRoot, { recursive: true });

function createFixture() {
  const root = fs.mkdtempSync(path.join(qaRoot, 'run-'));
  fs.mkdirSync(path.join(root, 'release'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const plan = publicFilePlan(root, '9.9.9');
  for (const name of plan.files) fs.writeFileSync(path.join(root, 'release', name), Buffer.alloc(1024 * 1024 + 1, 7));
  for (const [name] of plan.copies) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `Offline public fixture: ${name}\n`);
  }
  return { root, plan, destination: path.join(root, 'release', '续航台-9.9.9-发布包') };
}

const clean = createFixture();
const result = prepareRelease(clean.root);
assert.equal(result.publicFiles, clean.plan.targets.length);
assertPublicDirectory(clean.destination, clean.plan.targets, { complete: true });
assert.deepEqual(prepareRelease(clean.root), result, 'Repeat preparation remains deterministic.');
const checksumRows = fs.readFileSync(path.join(clean.destination, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
assert.equal(checksumRows.length, 3);
for (const row of checksumRows) {
  const [expected, filename] = row.split(/\s{2}/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(clean.destination, filename))).digest('hex'), expected);
}

const unexpected = createFixture();
fs.mkdirSync(unexpected.destination);
const unknownFile = path.join(unexpected.destination, 'private-fixture.txt');
const existingReadme = path.join(unexpected.destination, 'README.md');
fs.writeFileSync(unknownFile, 'Never remove or publish this fixture.');
fs.writeFileSync(existingReadme, 'Must remain unchanged when preparation is rejected.');
assert.throws(() => prepareRelease(unexpected.root), /Unexpected file/);
assert.equal(fs.readFileSync(unknownFile, 'utf8'), 'Never remove or publish this fixture.');
assert.equal(fs.readFileSync(existingReadme, 'utf8'), 'Must remain unchanged when preparation is rejected.');
assert.equal(fs.existsSync(path.join(unexpected.destination, 'SHA256SUMS.txt')), false);

const unexpectedDirectory = createFixture();
fs.mkdirSync(path.join(unexpectedDirectory.destination, 'data'), { recursive: true });
assert.throws(() => prepareRelease(unexpectedDirectory.root), /Unexpected directory/);
assert.equal(fs.existsSync(path.join(unexpectedDirectory.destination, 'data')), true);

const cliHome = path.join(clean.root, 'fixture-user');
const cliPath = path.join(cliHome, 'AppData', 'Roaming', 'npm', 'claude.cmd');
fs.mkdirSync(path.dirname(cliPath), { recursive: true });
fs.writeFileSync(cliPath, '@echo off\r\necho Offline fixture only\r\n');
assert.equal(resolveClaudeCommand({ home: cliHome, environment: {} }), cliPath);
assert.equal(resolveClaudeCommand({ home: 'unused', environment: { CLAUDE_CODE_PATH: cliPath } }), cliPath);
assert.equal(resolveClaudeCommand({ home: 'unused', environment: { PATH: path.dirname(cliPath) } }), cliPath);
assert.throws(() => resolveClaudeCommand({ home: cliHome, environment: { CLAUDE_CODE_PATH: path.join(clean.root, 'missing.cmd') } }), /CLI not found/);

const gitFixture = fs.mkdtempSync(path.join(qaRoot, 'ignore-'));
fs.copyFileSync(path.resolve(__dirname, '../.gitignore'), path.join(gitFixture, '.gitignore'));
execFileSync('git', ['init', '--quiet', gitFixture], { windowsHide: true, stdio: 'pipe' });
const privatePaths = ['.qa/check.json', 'artifacts/ui-review/report.json', 'claude-api-live-fixture/report.json', 'live-test/report.json', 'release/build.exe', 'data/workbench.json', '.env.production', 'nested/api-secrets.local.json', 'nested/auth.json', 'backups/original.json', 'exports/usage.csv'];
const publicPaths = ['src/main/index.ts', 'tests/manager.test.cjs', 'LICENSE', 'LICENSES/React-MIT.txt', 'docs/INSTALL.zh-CN.md', 'package-lock.json', '.env.example'];
const ignored = execFileSync('git', ['-C', gitFixture, 'check-ignore', '--no-index', '--stdin'], { input: [...privatePaths, ...publicPaths].join('\n') + '\n', windowsHide: true, encoding: 'utf8' }).trim().split(/\r?\n/);
assert.deepEqual(ignored.sort(), privatePaths.sort(), 'Private files must be ignored while public sources remain eligible.');

process.stdout.write(JSON.stringify({ pass: true, checks: ['Exact public files and licenses', 'Repeat preparation', 'Artifact checksums', 'Unexpected file rejected without modification', 'Unexpected data directory retained and rejected', 'Claude CLI home, override and PATH discovery', 'Git ignores private state and retains public sources'], modelCalls: 0, userConfigurationsReadOrChanged: false }));
