'use strict';
/*
 * shape-core.js — HarfBuzz ground-truth tier (OPTIONAL, lazy-loaded).
 *
 * The static tier reasons about CSS/markup. This tier reasons about what the
 * FONT actually does when it shapes the text — the only way to catch:
 *   - render-tofu           a glyph shapes to .notdef (g === 0): the char has
 *                           no glyph in this face → the reader sees ▯
 *   - render-fake-arabic-font  a "font" that does no Arabic joining at all
 *                           (normal output == output with joining disabled) —
 *                           i.e. a Latin face faking Arabic
 *   - render-mark-collision  a combining mark (\p{Mn}) placed at dx=0,dy=0 —
 *                           no GPOS attachment, so tashkeel lands on the base
 *
 * Deps (optionalDependencies): harfbuzzjs (WASM) + fontkit. If either is
 * missing we degrade to { available:false } and never throw — mirroring the
 * static tier's try/require pattern.
 */
const fs = require('fs');
const path = require('path');
const SC = require('@ottospace/rtl-scripts');

const REF_FONT = path.join(__dirname, '..', 'assets', 'Amiri-Regular.ttf');
const MARK_RE = /\p{Mn}/u;
const JOIN_PAIR = 'بب'; // two beh — a guaranteed medial/initial join in any real Arabic face
const NO_JOIN_FEATURES = '-calt,-rlig,-liga,-init,-medi,-fina';

// ── lazy HarfBuzz loader (memoized) ────────────────────────────────────────
let _hbPromise = null;
function loadHB() {
  if (_hbPromise) return _hbPromise;
  _hbPromise = (async () => {
    // Modern harfbuzzjs (>=0.5): the package default export is a Promise<hb>
    // whose emscripten glue loads hb.wasm (via require.resolve) for us.
    try {
      const mod = require('harfbuzzjs');
      if (mod && typeof mod.then === 'function') {
        const hb = await mod;
        if (hb && typeof hb.createBlob === 'function') return hb;
      }
      if (mod && typeof mod.createBlob === 'function') return mod;
    } catch { /* fall through */ }
    // Classic harfbuzzjs (0.3.x–0.4.x): hbjs(instance) over a raw hb.wasm.
    try {
      const hbjs = require('harfbuzzjs/hbjs.js');
      const bytes = fs.readFileSync(require.resolve('harfbuzzjs/hb.wasm'));
      let memory;
      const env = {
        _emscripten_runtime_keepalive_clear: () => {},
        _abort_js: () => { throw new Error('hb abort'); },
        _setitimer_js: () => {},
        emscripten_resize_heap: (req) => {
          try { if (!memory) return 0; req >>>= 0; const cur = memory.buffer.byteLength; if (req <= cur) return 1; memory.grow(Math.ceil((req - cur) / 65536)); return 1; } catch { return 0; }
        },
      };
      const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: { proc_exit: () => {} }, env });
      memory = instance.exports.memory;
      const hb = hbjs(instance);
      if (hb && typeof hb.createBlob === 'function') return hb;
    } catch { /* fall through */ }
    return null;
  })().catch(() => null);
  return _hbPromise;
}

async function isAvailable() { return !!(await loadHB()); }

// ── low-level shape ────────────────────────────────────────────────────────
/**
 * shape(fontBytes, text, {dir, script, lang, features}) → array of glyph
 * records { g, cl, ax, ay, dx, dy, flags } (HarfBuzz's own serialization).
 * `features` is a comma string, e.g. '' or '-calt,-rlig'. Throws only if HB is
 * unavailable — callers guard with isAvailable().
 */
async function shape(fontBytes, text, opts = {}) {
  const hb = await loadHB();
  if (!hb) throw new Error('harfbuzzjs unavailable');
  const blob = hb.createBlob(fontBytes);
  const face = hb.createFace(blob, 0);
  const font = hb.createFont(face);
  const buffer = hb.createBuffer();
  buffer.addText(text);
  if (opts.dir) buffer.setDirection(opts.dir);
  if (opts.script && buffer.setScript) buffer.setScript(opts.script);
  if (opts.lang && buffer.setLanguage) buffer.setLanguage(opts.lang);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer, opts.features != null ? opts.features : '');
  const out = buffer.json(font);
  buffer.destroy();
  if (font.destroy) font.destroy();
  if (face.destroy) face.destroy();
  if (blob.destroy) blob.destroy();
  return out;
}

// ── detector: tofu (missing glyphs) ────────────────────────────────────────
async function detectTofu(fontBytes, text, opts = {}) {
  const glyphs = await shape(fontBytes, text, opts);
  const missing = [];
  const seen = new Set();
  for (const g of glyphs) {
    if (g.g !== 0) continue;
    const cp = text.codePointAt(g.cl);
    if (cp == null) continue;
    const ch = String.fromCodePoint(cp);
    const key = cp + ':' + g.cl;
    if (seen.has(key)) continue; seen.add(key);
    missing.push({ char: ch, codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'), cluster: g.cl });
  }
  return missing; // [] means every char had a glyph
}

// ── detector: does this face actually do Arabic joining? ───────────────────
/**
 * A real Arabic face shapes "بب" differently with joining ON vs OFF. A Latin
 * face faking Arabic (or one with no GSUB joining) produces identical output —
 * or tofu — for both. Returns { joins, normal, noJoin, tofu }.
 */
async function fontJoinsArabic(fontBytes) {
  const normal = await shape(fontBytes, JOIN_PAIR, { features: '' });
  const noJoin = await shape(fontBytes, JOIN_PAIR, { features: NO_JOIN_FEATURES });
  const ids = (a) => a.map(g => g.g).join(',');
  const tofu = normal.some(g => g.g === 0);
  const joins = !tofu && ids(normal) !== ids(noJoin);
  return { joins, tofu, normal: ids(normal), noJoin: ids(noJoin) };
}

// ── detector: combining marks with no GPOS attachment (dx=0 && dy=0) ────────
async function detectMarkCollision(fontBytes, text, opts = {}) {
  if (!MARK_RE.test(text)) return [];
  const glyphs = await shape(fontBytes, text, opts);
  const hits = [];
  for (const g of glyphs) {
    if (g.g === 0) continue;              // tofu handled separately
    if (g.dx !== 0 || g.dy !== 0) continue; // has an attachment offset → fine
    const cp = text.codePointAt(g.cl);
    if (cp == null) continue;
    const ch = String.fromCodePoint(cp);
    if (!MARK_RE.test(ch)) continue;      // only combining marks
    hits.push({ char: ch, codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'), cluster: g.cl });
  }
  return hits;
}

// ── high-level: analyze one text run against a face → findings[] ───────────
/**
 * analyze(fontBytes, text, {label, dir, script, lang, fontName}) → findings[]
 * of shape { rule, sev:'render', from, msg, evidence }. `label` is a short id of
 * the text run (e.g. the first chars) surfaced in `from`.
 */
async function analyze(fontBytes, text, opts = {}) {
  const findings = [];
  const scripts = SC.detectScripts(text);
  if (!scripts.length) return findings;
  const cursive = SC.anyCursive(scripts);
  const label = opts.label || (text.length > 24 ? text.slice(0, 24) + '…' : text);
  const shapeOpts = { dir: opts.dir, script: opts.script, lang: opts.lang };

  // tofu — any script
  try {
    const tofu = await detectTofu(fontBytes, text, shapeOpts);
    if (tofu.length) {
      const chars = tofu.map(t => `${t.char} (${t.codepoint})`).join(', ');
      findings.push({ rule: 'render-tofu', sev: 'render', from: label,
        msg: `the rendered face has NO glyph for ${tofu.length} char(s) → the reader sees ▯: ${chars}`,
        evidence: { missing: tofu, font: opts.fontName || null } });
    }
  } catch {}

  // fake-arabic-font / broken-join — cursive scripts only
  if (cursive) {
    try {
      const j = await fontJoinsArabic(fontBytes);
      if (j.tofu) {
        findings.push({ rule: 'render-fake-arabic-font', sev: 'render', from: label,
          msg: `the rendered face cannot even shape the reference join "بب" (tofu) — it is not an Arabic font`,
          evidence: { normal: j.normal, noJoin: j.noJoin, font: opts.fontName || null } });
      } else if (!j.joins) {
        findings.push({ rule: 'render-broken-join', sev: 'render', from: label,
          msg: `the rendered face does NO Arabic joining — output with joining ON == joining OFF, so cursive letters render disconnected (fake-Arabic / Latin fallback)`,
          evidence: { normal: j.normal, noJoin: j.noJoin, font: opts.fontName || null } });
      }
    } catch {}
  }

  // mark-collision — combining marks
  try {
    const marks = await detectMarkCollision(fontBytes, text, shapeOpts);
    if (marks.length) {
      const chars = marks.map(m => `${m.char} (${m.codepoint})`).join(', ');
      findings.push({ rule: 'render-mark-collision', sev: 'render', from: label,
        msg: `${marks.length} combining mark(s) shaped with no GPOS attachment (dx=0,dy=0) → tashkeel/marks collide with the base: ${chars}`,
        evidence: { marks, font: opts.fontName || null } });
    }
  } catch {}

  return findings;
}

// ── extract complex-script text runs from arbitrary source ─────────────────
// A run = a maximal non-ASCII slice that contains at least one tracked script
// char (marks, ZWJ/ZWNJ ride along). Used by `--render` over source files.
function extractRuns(src, maxRuns = 200) {
  const runs = [];
  const re = /[^\x00-\x7F][^\x00-\x7F\s]*(?:\s[^\x00-\x7F\s]+)*/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(src)) !== null && runs.length < maxRuns) {
    const text = m[0].trim();
    if (!text) continue;
    if (!SC.detectScripts(text).length) continue;
    if (seen.has(text)) continue; seen.add(text);
    runs.push({ text, index: m.index });
  }
  return runs;
}

function referenceFontBytes() {
  try { return fs.readFileSync(REF_FONT); } catch { return null; }
}

module.exports = {
  isAvailable, shape, analyze,
  detectTofu, fontJoinsArabic, detectMarkCollision,
  extractRuns, referenceFontBytes, REF_FONT,
};
