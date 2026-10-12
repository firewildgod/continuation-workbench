// Reviewed public-source paths. Runtime state and generated binaries are never exported.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const roots = ['.gitignore', 'index.html', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'tsconfig.main.json', 'tsconfig.renderer.json', 'vite.config.ts'];
const documents = ['INSTALL.zh-CN.md', 'CONTRIBUTING.zh-CN.md', 'OFFICIAL-TOOLS.zh-CN.md', 'DEPENDENCY-SECURITY.md', 'claude-desktop-guide.md', 'claude-desktop-compatibility.md', 'brand-assets.md', 'download.html', 'release-0.2.0.md', 'release-0.2.1.md', 'release-0.2.2.md', 'release-0.2.3.md', 'github-workflows/README.md', 'github-workflows/windows-ci.yml', 'github-workflows/windows-release.yml'];
const assets = ['tray.png', 'relay-editorial.png', 'app-icon.svg', 'app-icon.png', 'app-icon.ico', 'previews/product-overview.png', 'previews/usage-and-cost.png', 'previews/portable-desktop.png', 'previews/README.md', 'previews/prompts.json'];
const screenshots = ['v2.2-workbench.png', 'v2.2-usage.png', 'v2.1-pricing-builtin.png', 'v2-connections.png'];
const optionalWorkflows = ['.github/workflows/windows-ci.yml', '.github/workflows/windows-release.yml'];

function regularSource(root, relative) {
  const absolute = path.resolve(root, relative);
  const local = path.relative(root, absolute);
  assert.ok(local && !local.startsWith('..') && !path.isAbsolute(local), 'Source must stay inside the project.');
  for (let current = absolute; current !== root; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, `Public source is a link: ${relative}`);
    assert.equal(current === absolute ? stat.isFile() : stat.isDirectory(), true, `Invalid public source: ${relative}`);
  }
  return absolute;
}

function publicSourcePlan(projectRoot) {
  const root = path.resolve(projectRoot);
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Project root must be a regular directory.');
  const files = [...roots, ...documents.map(name => `docs/${name}`), ...assets.map(name => `assets/${name}`), ...screenshots.map(name => `docs/screenshots/${name}`)];
  function walk(relative, extensions) {
    const directory = path.join(root, relative);
    const directoryStat = fs.lstatSync(directory);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), `Invalid source directory: ${relative}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      const entryStat = fs.lstatSync(path.join(root, name));
      assert.equal(entryStat.isSymbolicLink(), false, `Public source is a link: ${name}`);
      if (entryStat.isDirectory()) walk(name, extensions);
      else {
        assert.ok(entryStat.isFile() && extensions.has(path.extname(name)), `Unreviewed source type: ${name}`);
        files.push(name);
      }
    }
  }
  walk('src', new Set(['.ts', '.tsx', '.css']));
  walk('tests', new Set(['.cjs']));
  walk('scripts', new Set(['.cjs']));
  walk('LICENSES', new Set(['.txt']));
  for (const filename of optionalWorkflows) {
    if (fs.existsSync(path.join(root, filename))) files.push(filename);
  }
  assert.equal(new Set(files).size, files.length, 'Duplicate public source path.');
  return files.sort().map(relative => {
    const source = regularSource(root, relative);
    assert.ok(fs.statSync(source).size <= 20 * 1024 * 1024, `Public source too large: ${relative}`);
    return { relative, source };
  });
}

module.exports = { publicSourcePlan, regularSource };
