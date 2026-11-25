import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, mkdtemp, readdir, rm, access, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { isolatedLavish, launchBrowser, offlineRoutes, readLayoutIssues, closeVisualResources } from '../scripts/visual/browser.mjs';
import { scanDocument, partitionAccessibility } from '../scripts/visual/checks.mjs';

test('only known Lavish shell accessibility findings are ignored', () => {
  const node = target => ({ target: [target], summary: 'missing' });
  const violation = (id, ...targets) => ({ id, impact: 'serious', nodes: targets.map(node) });
  const result = partitionAccessibility([
    { scope: 'chrome', violations: [violation('frame-title', '#artifact', '#other'), violation('html-has-lang', 'html'), violation('color-contrast', '#artifact')] },
    { scope: 'artifact', violations: [violation('frame-title', '#artifact'), violation('html-has-lang', 'html')] },
  ]);
  assert.deepEqual(result.ignored.map(v => [v.id, v.nodes[0].target[0]]), [['frame-title', '#artifact'], ['html-has-lang', 'html']]);
  assert.deepEqual(result.actionable.map(v => [v.scope, v.id, v.nodes[0].target[0]]), [['chrome', 'frame-title', '#other'], ['chrome', 'color-contrast', '#artifact'], ['artifact', 'frame-title', '#artifact'], ['artifact', 'html-has-lang', 'html']]);
});

test('visual checker detects severely narrow wrapped paragraphs', async t => {
  const browser = await launchBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  await page.setContent('<html lang="en"><title>Width test</title><p id="narrow" style="width: 18px; overflow-wrap: anywhere">A long paragraph that should not be forced into a column only two characters wide.</p><p id="normal" style="width: 200px">A long paragraph that has enough space to be read comfortably at a normal width.</p></html>');
  const { geometry } = await scanDocument(page.mainFrame());
  assert.ok(geometry.narrowText.some(issue => issue.target === 'p#narrow'));
  assert.ok(!geometry.narrowText.some(issue => issue.target === 'p#normal'));
});

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

test('visual checker catches clipped ellipses, negative controls, and outer-clipped panes', async t => {
  const browser = await launchBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  await page.setContent(await readFile(path.join(import.meta.dirname, 'visual/fixtures/clipping.html'), 'utf8'));
  const { geometry } = await scanDocument(page.mainFrame());
  for (const target of ['p#multiline', 'p#short-ellipsis', 'p#nested-ellipsis', 'p#pane-text', 'p#pane-end']) {
    assert.ok(geometry.clippedText.some(issue => issue.target === target), `${target} must be reported`);
  }
  assert.ok(geometry.clippedText.some(issue => issue.target === 'p#pane-text' && issue.container === 'div#clipped-wrapper'));
  assert.ok(!geometry.clippedText.some(issue => issue.target === 'p#pane-clean'), 'visible text in a clipped pane is not clipped');
  for (const target of ['button#negative-top', 'button#negative-left']) {
    assert.ok(geometry.controls.some(issue => issue.target === target && issue.problem === 'off-screen-or-clipped'), `${target} must be unreachable`);
  }
  assert.ok(!geometry.controls.some(issue => issue.target === 'button#below-fold'));
  await page.evaluate(() => window.scrollTo(0, 1000));
  const scrolled = await scanDocument(page.mainFrame());
  assert.ok(!scrolled.geometry.controls.some(issue => issue.target === 'button#below-fold'), 'document scrolling must not make ordinary content unreachable');
});

test('isolated Lavish removes its directory after port allocation fails', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lavish-init-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await assert.rejects(isolatedLavish({ tempRoot, portAllocator: async () => { throw new Error('Injected port failure'); } }), /Injected port failure/);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('incomplete server cleanup is reported without signaling a discovered PID', async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  let discovered = false;
  const lavish = await isolatedLavish({ portAllocator: async () => server.address().port, shutdownTimeoutMs: 10, exec: (_name, args, options) => {
    const command = `lavish-axi server --port ${server.address().port}`;
    if (args.includes('-A')) return `${child.pid} ${command}\n`;
    discovered = true;
    return `${command} LAVISH_AXI_STATE_DIR=${options.env?.LAVISH_AXI_STATE_DIR || path.join(lavish.dir, 'lavish')}`;
  } });
  await assert.rejects(lavish.close(), error => {
    assert.match(error.message, /cleanup incomplete/);
    assert.equal(error.cleanup.serverStopped, false);
    return true;
  });
  assert.equal(discovered, true);
  assert.equal(server.listening, true);
  assert.equal(child.exitCode, null);
  process.kill(child.pid, 0);
});

test('browser-close failure still runs Lavish teardown and aggregates errors', async () => {
  let lavishClosed = false;
  const cleanup = { serverStopped: true, tempRemoved: true };
  const result = await closeVisualResources(
    { close: async () => { throw new Error('Injected browser-close failure'); } },
    { close: async () => { lavishClosed = true; const error = new Error('Injected Lavish cleanup failure'); error.cleanup = cleanup; throw error; } },
  );
  assert.equal(lavishClosed, true); assert.deepEqual(result.cleanup, cleanup);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /browser-close failure/); assert.match(result.errors[1], /Lavish cleanup failure/);
});

for (const failure of ['end', 'state', 'partial-open']) {
  test(`isolated Lavish cleans up after ${failure} failure`, { timeout: 60000 }, async t => {
    const exec = (name, args, options) => {
      const output = execFileSync(name, args, options);
      if (failure === 'state' && name === 'lavish-axi' && args[0] === 'end') execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(options.env.LAVISH_AXI_STATE_DIR, 'state.json'))}, 'unreadable JSON')`]);
      if (failure === 'end' && name === 'lavish-axi' && args[0] === 'end') throw new Error('Injected end failure');
      if (failure === 'partial-open' && name === 'lavish-axi' && args.includes('--no-open')) throw new Error('Injected failure after server startup');
      return output;
    };
    const lavish = await isolatedLavish({ exec, shutdownTimeoutMs: 200 }); let teardown;
    t.after(async () => { if (!teardown) await closeVisualResources(undefined, lavish); });
    const file = path.join(lavish.dir, 'clean.html');
    await cp(path.join(import.meta.dirname, 'visual/fixtures/clean.html'), file);
    if (failure === 'partial-open') assert.throws(() => lavish.open(file), /failure after server startup/);
    else lavish.open(file);
    const browser = failure === 'end' ? { close: async () => { throw new Error('Injected browser-close failure'); } } : undefined;
    teardown = await closeVisualResources(browser, lavish);
    assert.equal(teardown.cleanup.serverStopped, true); assert.equal(teardown.cleanup.tempRemoved, true);
    await assert.rejects(access(lavish.dir), { code: 'ENOENT' });
    if (failure === 'partial-open') { assert.deepEqual(teardown.errors, []); assert.equal(teardown.cleanup.sessionsEnded, 1); }
    else {
      assert.ok(teardown.errors.length > 0);
      if (failure === 'end') { assert.match(teardown.errors.join('; '), /Injected end failure/); assert.match(teardown.errors.join('; '), /browser-close failure/); }
      if (failure === 'state') assert.match(teardown.errors.join('; '), /JSON/);
    }
  });
}

for (const kind of ['clean', 'broken']) {
  test(`visual checker catches ${kind} fixture through real Lavish`, { timeout: 60000 }, async t => {
    const lavish = await isolatedLavish(); let browser;
    t.after(async () => { const { cleanup, errors } = await closeVisualResources(browser, lavish); assert.deepEqual(errors, []); assert.equal(cleanup.serverStopped, true); assert.equal(cleanup.tempRemoved, true); });
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
