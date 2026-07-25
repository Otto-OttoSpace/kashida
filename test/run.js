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

// ---------------------------------------------------------------------------
// Live tier — cursive per-character split heuristic (render-cursive-split).
// classifyCursiveSplit() is the exact logic the headless-Chromium DOM walker
// runs, exported so we can unit-test it WITHOUT launching a browser. The
// synthetic fixture is the trimmed text of an element's direct children.
// ---------------------------------------------------------------------------
const liveCore = require(path.join(ROOT, 'lib', 'live-core.js'));

test('live: per-character Arabic split is detected + reconstructed', () => {
  // <div class="split"><span>م</span><span>ر</span>… — SplitText type:'chars'
  const r = liveCore.classifyCursiveSplit(['م', 'ر', 'ح', 'ب', 'ا']);
  assert.strictEqual(r.split, true, 'per-glyph Arabic boxes must flag as a split');
  assert.strictEqual(r.word, 'مرحبا', 'the joined run is reconstructed from the boxes');
  assert.strictEqual(r.pieces, 5);
});

test('live: a single letter + tashkeel still counts as one box', () => {
  // graphemes like "مَ" (beh + fatha) are one cursive letter, not two.
  const r = liveCore.classifyCursiveSplit(['مَ', 'رْ', 'حَ', 'بَ']);
  assert.strictEqual(r.split, true);
  assert.strictEqual(r.pieces, 4);
});

test('live: word/line boxes are NOT a per-char split', () => {
  assert.strictEqual(liveCore.classifyCursiveSplit(['مرحبا', 'بالعالم']).split, false);
});

test('live: Latin per-character boxes are NOT flagged (no false positive)', () => {
  assert.strictEqual(liveCore.classifyCursiveSplit(['H', 'e', 'l', 'l', 'o']).split, false);
});

test('live: isSingleCursiveBox — one Arabic letter yes, a word no', () => {
  assert.strictEqual(liveCore.isSingleCursiveBox('م'), true);
  assert.strictEqual(liveCore.isSingleCursiveBox('مر'), false);
  assert.strictEqual(liveCore.isSingleCursiveBox('م ر'), false); // whitespace → not a glyph box
  assert.strictEqual(liveCore.isSingleCursiveBox('a'), false);
});

// ---------------------------------------------------------------------------
// Shape tier (HarfBuzz ground truth). Optional dependency — these tests SKIP
// (not fail) when harfbuzzjs isn't installed, so the default install stays green.
// ---------------------------------------------------------------------------
let shapeCore = null;
try { shapeCore = require(path.join(ROOT, 'lib', 'shape-core.js')); } catch { shapeCore = null; }

test('shape: reference face is bundled', () => {
  const bytes = shapeCore && shapeCore.referenceFontBytes();
  assert.ok(bytes && bytes.length > 1000, 'assets/Amiri-Regular.ttf should be bundled');
});

test('shape: bundled Arabic face DOES join (not a fake-Arabic font)', async (t) => {
  if (!shapeCore || !(await shapeCore.isAvailable())) return t.skip('harfbuzzjs not installed');
  const j = await shapeCore.fontJoinsArabic(shapeCore.referenceFontBytes());
  assert.strictEqual(j.tofu, false, 'reference face must render the join pair بب');
  assert.strictEqual(j.joins, true, 'reference face must actually join Arabic');
});

test('shape: reference face over Arabic → no tofu, no mark collision', async (t) => {
  if (!shapeCore || !(await shapeCore.isAvailable())) return t.skip('harfbuzzjs not installed');
  const findings = await shapeCore.analyze(shapeCore.referenceFontBytes(), 'مَرْحَبًا بالعالم', { fontName: 'Amiri' });
  assert.deepStrictEqual(findings, [], 'a real Arabic face must produce zero render findings on Arabic');
});

test('shape: render-tofu when a face lacks the script (Amiri over CJK)', async (t) => {
  if (!shapeCore || !(await shapeCore.isAvailable())) return t.skip('harfbuzzjs not installed');
  const findings = await shapeCore.analyze(shapeCore.referenceFontBytes(), '你好世界', { fontName: 'Amiri' });
  assert.ok(findings.some(f => f.rule === 'render-tofu'), 'CJK text in an Arabic-only face must flag render-tofu');
});

test('shape: render-tofu + fake-Arabic-font when a LATIN font shapes Arabic', async (t) => {
  if (!shapeCore || !(await shapeCore.isAvailable())) return t.skip('harfbuzzjs not installed');
  // Prefer a bundled Latin-only fixture; else use a known Latin-only macOS system font.
  const candidates = [
    path.join(ROOT, 'test', 'fixtures', 'latin-only.ttf'),
    '/System/Library/Fonts/Monaco.ttf',
    '/System/Library/Fonts/Supplemental/Andale Mono.ttf',
    '/System/Library/Fonts/Supplemental/Impact.ttf',
  ];
  const latin = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!latin) return t.skip('no Latin-only font available on this machine');
  const findings = await shapeCore.analyze(fs.readFileSync(latin), 'مرحبا', { fontName: path.basename(latin) });
  assert.ok(findings.some(f => f.rule === 'render-tofu'), 'a Latin font shaping Arabic must flag render-tofu');
  assert.ok(findings.some(f => f.rule === 'render-fake-arabic-font'), 'a Latin font shaping Arabic must flag render-fake-arabic-font');
});
