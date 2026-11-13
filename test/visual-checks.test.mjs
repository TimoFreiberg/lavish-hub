import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedLavish, launchBrowser, offlineRoutes, readLayoutIssues } from '../scripts/visual/browser.mjs';
import { scanDocument } from '../scripts/visual/checks.mjs';

test('visual checker allows reachable scroll panes, ellipses, and shadow controls', async t => {
  const browser = await launchBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  await page.setContent(await readFile(path.join(import.meta.dirname, 'visual/fixtures/scrollable.html'), 'utf8'));
  const result = await scanDocument(page.mainFrame());
  assert.deepEqual(result.geometry.clippedText, []); assert.deepEqual(result.geometry.controls, []);
  assert.equal(result.geometry.horizontalOverflow, false); assert.deepEqual(result.accessibility, []);
  await page.evaluate(() => { document.querySelector('#shadow').shadowRoot.querySelector('button').style.cssText = 'width:0;height:0;padding:0;border:0;overflow:hidden'; });
  const broken = await scanDocument(page.mainFrame());
  assert.ok(broken.geometry.controls.some(issue => issue.target.includes('>>>') && issue.problem === 'zero-size'));
});

for (const kind of ['clean', 'broken']) {
  test(`visual checker catches ${kind} fixture through real Lavish`, { timeout: 60000 }, async t => {
    const lavish = await isolatedLavish(); let browser;
    t.after(async () => { await browser?.close(); const cleanup = await lavish.close(); assert.equal(cleanup.serverStopped, true); assert.equal(cleanup.tempRemoved, true); });
    const file = path.join(lavish.dir, `${kind}.html`);
    await cp(path.join(import.meta.dirname, 'visual/fixtures', `${kind}.html`), file);
    browser = await launchBrowser(); const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
    await offlineRoutes(page); await page.goto(lavish.open(file));
    const frame = page.frames().find(f => f.parentFrame() === page.mainFrame());
    await frame.waitForSelector('h1');
    const issues = await readLayoutIssues(page);
    assert.deepEqual(await readLayoutIssues(page), issues, 'a repeated explicit audit must return the same inbox');
    const result = await scanDocument(frame);
    if (kind === 'clean') {
      assert.deepEqual(issues, []); assert.equal(result.geometry.horizontalOverflow, false);
      assert.deepEqual(result.geometry.clippedText, []); assert.deepEqual(result.geometry.controls, []);
      assert.deepEqual(result.accessibility, []);
    } else {
      assert.ok(issues.length > 0, 'Lavish detects the overflowing/clipped fixture');
      assert.equal(result.geometry.horizontalOverflow, true);
      assert.ok(result.geometry.clippedText.some(issue => issue.target === 'p#clip'));
      assert.ok(result.geometry.controls.some(issue => issue.target === 'button#covered' && issue.problem === 'overlapped'));
      assert.ok(result.geometry.controls.some(issue => issue.target === 'button#zero' && issue.problem === 'zero-size'));
      assert.ok(result.geometry.controls.some(issue => issue.target === 'button#offscreen' && issue.problem === 'off-screen-or-clipped'));
      assert.ok(result.accessibility.some(issue => issue.id === 'label' && issue.nodes.some(node => node.target.includes('#unlabelled'))));
    }
  });
}
