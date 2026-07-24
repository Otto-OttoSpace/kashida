'use strict';
/*
 * kashida regression suite (node --test).
 *
 * For every case under test/corpus/<case>/ it asserts, end-to-end through the
 * real CLI binary, that the `--json` scan findings (normalized) deep-equal
 * expected.findings.json. kashida is report-only, so there is no --fix to test;
 * the guarantee we protect is DETECTION correctness — especially that
 * english-* and fp-* fixtures produce ZERO findings (no false positives).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'kashida.js');
const CORPUS = path.join(__dirname, 'corpus');

function runCli(args) {
  try { return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }
  catch (e) { return (e.stdout || '') + ''; } // CLI exits 1 when findings remain
}

function scanFindings(file) {
  const out = JSON.parse(runCli([file, '--json']) || '{}');
  return (out.findings || [])
    .map(f => ({ rule: f.rule, sev: f.sev, line: f.line, from: f.from, to: f.to }))
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from));
}

const cases = fs.readdirSync(CORPUS)
  .filter(c => fs.statSync(path.join(CORPUS, c)).isDirectory())
  .sort();

assert.ok(cases.length >= 12, `expected the seeded corpus, found ${cases.length} cases`);

for (const name of cases) {
  const dir = path.join(CORPUS, name);
  const input = fs.readdirSync(dir).find(f => f.startsWith('input.'));
  const inputPath = path.join(dir, input);

  test(`${name}: scan findings match`, () => {
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.findings.json'), 'utf8'));
    assert.deepStrictEqual(scanFindings(inputPath), expected);
  });

  // The value-prop guarantee: nothing Latin/valid gets flagged.
  if (/^(english|fp)/.test(name)) {
    test(`${name}: zero findings (no false positives)`, () => {
      assert.strictEqual(scanFindings(inputPath).length, 0);
    });
  }
}
