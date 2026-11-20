import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { diffThemeCss, palette, syntaxTheme, themeCss } from '../src/orangebox.mjs';
import { createHighlighter } from 'shiki';

function run(...args) {
  return spawnSync(process.execPath, ['bin/lavish-kit', ...args], { encoding: 'utf8' });
}

test('theme CLI describes and exports the shared Orangebox theme', () => {
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /lavish-kit theme \[css\|syntax\|diff-css\]/);
  for (const args of [['theme'], ['theme', '--help']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /data-theme="orangebox"/);
    assert.match(result.stdout, /registerCustomTheme/);
  }
  const css = run('theme', 'css');
  assert.equal(css.status, 0, css.stderr);
  assert.ok(css.stdout.includes(themeCss));
  assert.match(css.stdout, /background: var\(--ob-bg\)/);
  const syntax = run('theme', 'syntax');
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.deepEqual(JSON.parse(syntax.stdout), syntaxTheme);
  const diff = run('theme', 'diff-css');
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(diff.stdout.trim(), diffThemeCss);
  assert.ok(diff.stdout.includes(palette['diff-add']));
  assert.ok(diff.stdout.includes(palette['diff-del']));
});

test('exported syntax theme works with Shiki', async () => {
  const result = run('theme', 'syntax');
  assert.equal(result.status, 0, result.stderr);
  const highlighter = await createHighlighter({ themes: [JSON.parse(result.stdout)], langs: ['javascript'] });
  try {
    const html = highlighter.codeToHtml('const answer = 42;', { lang: 'javascript', theme: 'orangebox' });
    assert.ok(html.includes(palette.bg));
    assert.ok(html.toLowerCase().includes(palette.orange.toLowerCase()));
  } finally {
    highlighter.dispose();
  }
});

test('theme CLI rejects invalid arguments', () => {
  for (const args of [['theme', 'unknown'], ['theme', 'css', 'extra']]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /theme accepts/);
  }
});
