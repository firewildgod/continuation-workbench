const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const folder = path.join(root, 'release', `续航台-${version}-发布包`);
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(folder, 'index.html')).href);
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    for (const filename of await page.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href')).filter(link => link && !link.startsWith('#')))) {
      if (/^https:\/\//i.test(filename)) { new URL(filename); continue; }
      assert.equal(/^[a-z][a-z\d+.-]*:/i.test(filename) || filename.startsWith('//'), false, `Unsupported public link: ${filename}`);
      const target = path.resolve(folder, decodeURIComponent(filename.split(/[?#]/, 1)[0]));
      const relative = path.relative(folder, target);
      assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `Public link escapes release directory: ${filename}`);
      assert.ok(fs.existsSync(target), `Missing public link: ${filename}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'docs', 'screenshots', 'v2-downloadpage.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    process.stdout.write(JSON.stringify({ pass: true, imagesLoaded: true, publicDownloadsExist: true, desktopAndMobileNoOverflow: true }));
  } finally { await browser.close(); }
}
main().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
