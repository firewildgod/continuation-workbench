// This pre-publication check reports paths and rule names, never matched credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { publicSourcePlan } = require('./public-source-plan.cjs');

const forbiddenPath = /(?:^|\/)(?:data|\.qa|artifacts|node_modules|dist|release|backups|exports|\.codex|\.claude|claude-api-live-[^/]*)(?:\/|$)|(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials\.json|api-secrets\.local\.json|gateway\.local\.json|workbench\.json|usage-ledger[^/]*)$/i;
const credentialRules = [
  ['GitHub credential', /github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,}/],
  ['Model API credential', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Cloud access credential', /\b(?:AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b/],
  ['Private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];

function checkPublicSource(projectRoot = path.resolve(__dirname, '..')) {
  const root = path.resolve(projectRoot);
  const plan = publicSourcePlan(root);
  const failures = [];
  const userHome = os.homedir().replaceAll('\\', '/').toLowerCase();
  for (const { relative, source } of plan) {
    if (forbiddenPath.test(relative)) failures.push({ file: relative, rule: 'Private runtime path' });
    if (!/\.(?:png|ico)$/i.test(relative)) {
      const contents = fs.readFileSync(source, 'utf8');
      for (const [rule, expression] of credentialRules) {
        if (expression.test(contents)) failures.push({ file: relative, rule });
      }
      if (userHome.length > 5 && contents.replaceAll('\\', '/').toLowerCase().includes(userHome + '/')) failures.push({ file: relative, rule: 'Current user absolute path' });
    }
  }
  if (fs.existsSync(path.join(root, '.git'))) {
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
    const allowed = new Set(plan.map(item => item.relative));
    for (const file of tracked) if (!allowed.has(file) || forbiddenPath.test(file)) failures.push({ file, rule: 'Unreviewed tracked path' });
  }
  assert.equal(failures.length, 0, `Public-source check failed: ${JSON.stringify(failures)}`);
  return { pass: true, files: plan.length, credentialPatternsChecked: credentialRules.length, privateRuntimePathsIncluded: false };
}

module.exports = { checkPublicSource };
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(checkPublicSource(process.argv[2] || undefined)) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
