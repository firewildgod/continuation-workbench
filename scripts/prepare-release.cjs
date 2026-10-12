/* Public distribution uses an explicit file allowlist, never the data folder. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function existsWithoutFollowingLinks(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function assertRegularSource(root, relative) {
  const source = path.join(root, relative);
  const relativePath = path.relative(root, source);
  assert.ok(relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath), 'Source must be inside the project.');
  for (let current = source; current !== root; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, `Public source cannot be a link: ${relative}`);
    if (current === source) assert.equal(stat.isFile(), true, `Public source must be a regular file: ${relative}`);
    else assert.equal(stat.isDirectory(), true, `Public source parent must be a directory: ${relative}`);
  }
  return source;
}

function publicFilePlan(root, version) {
  const files = [`Continuation-Workbench-${version}-portable.exe`, `Continuation-Workbench-${version}-x64.zip`, `Continuation-Workbench-${version}-setup.exe`];
  const copies = [
    ['docs/download.html', 'index.html'],
    ['README.md', 'README.md'],
    ['LICENSE', 'LICENSE'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ...['React-MIT.txt', 'ReactDOM-MIT.txt', 'Lucide-ISC.txt', 'Iarna-TOML-ISC.txt'].map(name => [`LICENSES/${name}`, `LICENSES/${name}`]),
    [`docs/release-${version}.md`, `docs/release-${version}.md`],
    ['docs/INSTALL.zh-CN.md', 'docs/INSTALL.zh-CN.md'],
    ['docs/CONTRIBUTING.zh-CN.md', 'docs/CONTRIBUTING.zh-CN.md'],
    ['docs/OFFICIAL-TOOLS.zh-CN.md', 'docs/OFFICIAL-TOOLS.zh-CN.md'],
    ['docs/DEPENDENCY-SECURITY.md', 'docs/DEPENDENCY-SECURITY.md'],
    ['docs/github-workflows/README.md', 'docs/github-workflows/README.md'],
    ['docs/github-workflows/windows-ci.yml', 'docs/github-workflows/windows-ci.yml'],
    ['docs/github-workflows/windows-release.yml', 'docs/github-workflows/windows-release.yml'],
    ...['product-overview.png', 'usage-and-cost.png', 'portable-desktop.png', 'README.md', 'prompts.json'].map(name => [`assets/previews/${name}`, `assets/previews/${name}`]),
    ['docs/claude-desktop-guide.md', 'docs/claude-desktop-guide.md'],
    ['docs/claude-desktop-compatibility.md', 'docs/claude-desktop-compatibility.md'],
    ['docs/brand-assets.md', 'docs/brand-assets.md'],
    ['assets/relay-editorial.png', 'relay-editorial.png'],
    ['assets/app-icon.png', 'app-icon.png'],
    ['assets/app-icon.svg', 'app-icon.svg'],
    ['assets/app-icon.ico', 'app-icon.ico'],
    [fs.existsSync(path.join(root, 'docs/screenshots/v2.2-workbench.png')) ? 'docs/screenshots/v2.2-workbench.png' : 'docs/screenshots/v2-workbench.png', 'workbench.png'],
    [fs.existsSync(path.join(root, 'docs/screenshots/v2.1-pricing-builtin.png')) ? 'docs/screenshots/v2.1-pricing-builtin.png' : 'docs/screenshots/v2-usage.png', 'usage.png'],
    ['docs/screenshots/v2-connections.png', 'connections.png'],
    ...['v2.2-workbench.png', 'v2.2-usage.png', 'v2.1-pricing-builtin.png', 'v2-connections.png'].map(name => [`docs/screenshots/${name}`, `docs/screenshots/${name}`]),
  ];
  const targets = [...files, ...copies.map(([, target]) => target), 'SHA256SUMS.txt', '发布说明.txt'].map(name => name.replaceAll('\\', '/'));
  assert.equal(new Set(targets).size, targets.length, 'Duplicate public destination.');
  return { files, copies, targets };
}

function assertPublicDirectory(destination, targets, { complete = false } = {}) {
  const allowedFiles = new Set(targets);
  const allowedDirectories = new Set(['']);
  for (const name of targets) {
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) allowedDirectories.add(parent);
  }
  const seen = new Set();
  function visit(directory, relative = '') {
    const stat = fs.lstatSync(directory);
    assert.equal(stat.isSymbolicLink(), false, 'Public destination cannot contain links.');
    assert.equal(stat.isDirectory(), true, 'Public destination must be a directory.');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      const child = fs.lstatSync(fullPath);
      assert.equal(child.isSymbolicLink(), false, `Unexpected link in public directory: ${name}`);
      if (child.isDirectory()) {
        assert.ok(allowedDirectories.has(name), `Unexpected directory in public release: ${name}; move it outside the release directory before retrying.`);
        visit(fullPath, name);
      } else {
        assert.equal(child.isFile(), true, `Unexpected non-regular file in public release: ${name}`);
        assert.ok(allowedFiles.has(name), `Unexpected file in public release: ${name}; move it outside the release directory before retrying.`);
        seen.add(name);
      }
    }
  }
  if (existsWithoutFollowingLinks(destination)) visit(destination);
  if (complete) assert.deepEqual([...seen].sort(), [...allowedFiles].sort(), 'Public release is incomplete.');
}

function prepareRelease(projectRoot = path.resolve(__dirname, '..')) {
  const root = path.resolve(projectRoot);
  const release = path.join(root, 'release');
  const releaseStat = fs.lstatSync(release);
  assert.equal(releaseStat.isDirectory() && !releaseStat.isSymbolicLink(), true, 'Release root must be a regular directory.');
  const version = JSON.parse(fs.readFileSync(assertRegularSource(root, 'package.json'), 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, 'Invalid release version.');
  const destination = path.join(release, `续航台-${version}-发布包`);
  const { files, copies, targets } = publicFilePlan(root, version);
  // Refuse stale or accidentally copied private state before any file is written.
  assertPublicDirectory(destination, targets);
  for (const name of files) assert.ok(fs.statSync(assertRegularSource(root, path.join('release', name))).size > 1024 * 1024, 'Release artifact is too small.');
  for (const [source] of copies) assertRegularSource(root, source);
  const rootChecksum = path.join(release, 'SHA256SUMS.txt');
  if (existsWithoutFollowingLinks(rootChecksum)) assertRegularSource(root, path.join('release', 'SHA256SUMS.txt'));
  for (const target of targets) fs.mkdirSync(path.dirname(path.join(destination, target)), { recursive: true });
  for (const name of files) fs.copyFileSync(path.join(release, name), path.join(destination, name));
  for (const [source, target] of copies) fs.copyFileSync(path.join(root, source), path.join(destination, target));
  const checksums = files.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex')}  ${name}`).join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), checksums);
  fs.writeFileSync(rootChecksum, checksums);
  fs.writeFileSync(path.join(destination, '发布说明.txt'), '这是可直接分发或上传到静态托管的公开发布目录。\r\n打开 index.html 查看产品介绍、截图、下载和说明。\r\n三个二进制文件使用 SHA256SUMS.txt 核验。安装包没有 Windows 代码签名。\r\n目录不含 API Key、会员凭据、个人调用记录或开发测试数据。\r\n请整体保留相对文件结构。官方工具安装与网络说明见 docs/OFFICIAL-TOOLS.zh-CN.md。\r\n', 'utf8');
  assertPublicDirectory(destination, targets, { complete: true });
  return { destination, artifacts: files, publicAssets: 10, publicFiles: targets.length, privateDataIncluded: false };
}

module.exports = { prepareRelease, publicFilePlan, assertPublicDirectory };
if (require.main === module) process.stdout.write(JSON.stringify(prepareRelease()));
