'use strict';
/*
 * kashida --font-fix regression suite. Generates the scoped Arabic/RTL font-fix
 * CSS (the productized ottospace.co/ar fix) and asserts the key corrections.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'kashida.js');
const FILE = 'kashida-arabic-fallback.css';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kashida-ff-'));

test('font-fix: writes scoped Arabic-font CSS with the key corrections', () => {
  const d = tmp();
  try {
    execFileSync(process.execPath, [CLI, d, '--font-fix'], { encoding: 'utf8' });
    const css = fs.readFileSync(path.join(d, FILE), 'utf8');
    for (const needle of ['IBM Plex Sans Arabic', 'letter-spacing: normal', '[lang="ar"]', '[dir="rtl"]', '@import', 'line-height'])
      assert.ok(css.includes(needle), `fix CSS missing "${needle}"`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('font-fix: --json reports the written path, file exists, exit 0', () => {
  const d = tmp();
  try {
    const out = execFileSync(process.execPath, [CLI, d, '--font-fix', '--json'], { encoding: 'utf8' });
    const j = JSON.parse(out);
    assert.ok(j.wrote.endsWith(FILE), 'json.wrote should end with the css filename');
    assert.ok(fs.existsSync(j.wrote), 'the css file should exist');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
