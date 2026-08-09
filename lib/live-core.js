'use strict';
/*
 * live-core.js — RENDER-TIME tier (OPTIONAL, lazy-loaded).
 *
 * The static tier reads your source; the shape tier reads a font. This tier
 * reads the REAL PAGE: it launches headless Chromium, waits for webfonts, and
 * inspects every visible text node the way a browser actually renders it —
 * computed style, the ACTUAL platform font Chromium picked (via CDP
 * CSS.getPlatformFontsForNode, with per-family glyphCount as proof), and the
 * downloaded font bytes (woff2 → HarfBuzz). That catches the failure the
 * source can't show: an Arabic string that a Latin family is silently
 * rendering (forced-Latin / tofu) at run time.
 *
 * Deps (optionalDependencies): playwright + wawoff2. If Playwright can't be
 * installed/launched (common in sandboxes) callers fall back to `curlAnalyze`,
 * which fetches the HTML + CSS and shapes with the bundled reference face.
 */
const https = require('https');
const http = require('http');
const SC = require('@ottospace/rtl-scripts');
const shapeCore = require('./shape-core');

// ── availability ───────────────────────────────────────────────────────────
function playwrightModule() { try { return require('playwright'); } catch { return null; } }
async function isAvailable() { return !!playwrightModule(); }
function woff2() { try { return require('wawoff2'); } catch { return null; } }

const FONT_URL_RE = /\.(?:woff2|woff|ttf|otf)(?:[?#]|$)/i;

function familyIsLatinOnly(family) {
  const f = String(family).toLowerCase();
  if (!f) return false;
  // named Arabic families / the word "arabic" → not Latin-only
  if (f.includes('arabic')) return false;
  const ARABIC = ['cairo', 'tajawal', 'almarai', 'amiri', 'el messiri', 'changa', 'markazi', 'lateef', 'scheherazade', 'reem kufi', 'harmattan', 'mada', 'katibeh', 'lalezar', 'jomhuria', 'aref ruqaa', 'readex', 'noto naskh', 'noto kufi', 'ibm plex sans arabic', 'dubai', 'sakkal', 'geeza', 'baghdad', 'al bayan', 'ge ', 'neo sans arabic', 'gess'];
  return !ARABIC.some(a => f.includes(a));
}

// ── per-character cursive split (SplitText type:'chars' etc.) ────────────────
// Text-animation splitters wrap EACH Arabic letter in its own element; a cursive
// script can't join across element boundaries, so every letter renders isolated
// ("cut" Arabic). We detect the DOM shape it leaves: a container whose direct
// children are each a single-cursive-letter box.  The RTL-cursive family per
// lib/scripts: Arabic, Syriac, Thaana, N'Ko, Adlam.
const CURSIVE_SPLIT_RE = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;
const CURSIVE_MARK_RE = /\p{Mn}/u;
const CURSIVE_SPLIT_FIX = "Cursive/RTL text is split into per-character elements (e.g. SplitText type:'chars') — letters can't join across element boundaries. Split by word or line, or exclude RTL/cursive text from per-character animation.";

// Count cursive BASE letters (combining marks/tashkeel ride along, not counted).
function cursiveLetterCount(s) {
  let n = 0;
  for (const ch of (s || '')) if (CURSIVE_SPLIT_RE.test(ch) && !CURSIVE_MARK_RE.test(ch)) n++;
  return n;
}
// A "single cursive box" holds exactly one cursive letter and no whitespace —
// i.e. one glyph broken out of a word (a real word box would hold spaces/more).
function isSingleCursiveBox(text) {
  const t = (text || '').trim();
  if (!t || /\s/.test(t)) return false;
  return cursiveLetterCount(t) === 1;
}
/**
 * classifyCursiveSplit(childTexts) — given the trimmed text of an element's
 * DIRECT child elements (in DOM order), decide whether they are a per-character
 * cursive split. Returns { split, word, pieces, children }. `word` is the run
 * reconstructed by joining the single-letter boxes in DOM (logical) order. This
 * is the exact heuristic the in-page walker runs, exported so it is unit-testable
 * without a browser.
 */
function classifyCursiveSplit(childTexts) {
  const children = childTexts.length;
  const boxes = childTexts.filter(isSingleCursiveBox);
  const word = boxes.join('');
  const split = boxes.length >= 3 && boxes.length >= children * 0.6 && cursiveLetterCount(word) >= 3;
  return { split, word: word.slice(0, 80), pieces: boxes.length, children };
}

// ── Playwright path ─────────────────────────────────────────────────────────
/**
 * run(url, {render, font, timeout}) → { url, path, findings[], fonts[], nodes }
 * findings: { url, selector, text, scripts, rule, sev, evidence, fix }
 */
async function run(url, opts = {}) {
  const playwright = playwrightModule();
  if (!playwright) throw new Error('playwright unavailable');
  const timeout = opts.timeout || 30000;
  const browser = await playwright.chromium.launch({ headless: true });
  const findings = [];
  const capturedFonts = new Map(); // family/url → bytes
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // capture downloaded font bytes
    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!FONT_URL_RE.test(u)) return;
        const buf = await resp.body();
        capturedFonts.set(u, buf);
      } catch {}
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}

    // <html> lang/dir sanity
    const htmlMeta = await page.evaluate(() => ({
      lang: document.documentElement.getAttribute('lang') || '',
      dir: document.documentElement.getAttribute('dir') || (getComputedStyle(document.documentElement).direction || ''),
    }));

    // Collect visible text nodes + computed style + stable selector + rect.
    const nodes = await page.evaluate(() => {
      function cssPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 6 && cur !== document.body) {
          let sel = cur.tagName.toLowerCase();
          const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.');
          const parent = cur.parentElement;
          if (parent) {
            const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
            if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
          }
          parts.unshift(sel);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const el = n.parentElement;
          if (!el) return NodeFilter.FILTER_REJECT;
          const tag = el.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const el = node.parentElement;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        out.push({
          text: node.nodeValue.trim().slice(0, 400),
          selector: cssPath(el),
          fontFamily: cs.fontFamily,
          letterSpacing: cs.letterSpacing,
          wordSpacing: cs.wordSpacing,
          direction: cs.direction,
          fontFeatureSettings: cs.fontFeatureSettings,
          fontVariantLigatures: cs.fontVariantLigatures,
          textTransform: cs.textTransform,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
      return out;
    });

    // per-character cursive split — DOM structure walk (SplitText type:'chars',
    // .split('').map(c=>span), …). Keep this heuristic in sync with the exported
    // classifyCursiveSplit() in this module (unit-tested without a browser).
    const cursiveSplits = await page.evaluate(() => {
      const CURSIVE = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;
      const MARK = /\p{Mn}/u;
      function letters(s) { let n = 0; for (const ch of (s || '')) if (CURSIVE.test(ch) && !MARK.test(ch)) n++; return n; }
      function isBox(el) { const t = (el.textContent || '').trim(); if (!t || /\s/.test(t)) return false; return letters(t) === 1; }
      function cssPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 6 && cur !== document.body) {
          let sel = cur.tagName.toLowerCase();
          const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.');
          const parent = cur.parentElement;
          if (parent) {
            const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
            if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
          }
          parts.unshift(sel);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
      const out = []; const seen = new Set();
      for (const el of document.body.querySelectorAll('*')) {
        const kids = Array.from(el.children);
        if (kids.length < 3) continue;
        const boxes = kids.filter(isBox);
        if (boxes.length < 3 || boxes.length < kids.length * 0.6) continue;
        const word = boxes.map(b => (b.textContent || '').trim()).join('');
        if (letters(word) < 3) continue;
        const sel = cssPath(el);
        if (seen.has(sel)) continue; seen.add(sel);
        out.push({ selector: sel, word: word.slice(0, 80), pieces: boxes.length, children: kids.length });
      }
      return out;
    });
    for (const s of cursiveSplits) {
      findings.push({ url, selector: s.selector, text: s.word,
        scripts: SC.detectScripts(s.word).map(x => x.name),
        rule: 'render-cursive-split', sev: 'render',
        evidence: { pieces: s.pieces, children: s.children, word: s.word },
        fix: CURSIVE_SPLIT_FIX });
    }

    // CDP: which platform font did Chromium actually use per node? glyphCount is proof.
    let cdp = null;
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
    } catch { cdp = null; }
    async function platformFontsFor(selector) {
      if (!cdp || !selector) return null;
      try {
        const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) return null;
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        return fonts || null;
      } catch { return null; }
    }

    // lang/dir findings
    const pageScripts = SC.detectScripts(nodes.map(n => n.text).join(' '));
    if (pageScripts.length) {
      const rtl = SC.anyRtl(pageScripts);
      if (rtl && !/rtl/i.test(htmlMeta.dir)) findings.push({ url, selector: 'html', text: '', scripts: pageScripts.map(s => s.name), rule: 'missing-dir', sev: 'render', evidence: { htmlDir: htmlMeta.dir || '(none)' }, fix: 'set <html dir="rtl"> — RTL scripts are present but the document direction is not rtl' });
      if (!htmlMeta.lang) findings.push({ url, selector: 'html', text: '', scripts: pageScripts.map(s => s.name), rule: 'missing-lang', sev: 'render', evidence: { htmlLang: '(none)' }, fix: 'set <html lang="…"> for the page language' });
    }

    // per-node analysis
    const refFont = opts.font || shapeCore.referenceFontBytes();
    for (const n of nodes) {
      const scripts = SC.detectScripts(n.text);
      if (!scripts.length) continue;
      const names = scripts.map(s => s.name);
      const cursiveOrComplex = SC.anyCursiveOrComplex(scripts);
      const base = { url, selector: n.selector, text: n.text.slice(0, 80), scripts: names };

      // static-at-render: letter/word-spacing on cursive||complex
      if (cursiveOrComplex && n.letterSpacing && n.letterSpacing !== 'normal' && parseFloat(n.letterSpacing) !== 0) {
        findings.push({ ...base, rule: 'letter-spacing', sev: 'render', evidence: { letterSpacing: n.letterSpacing }, fix: 'remove letter-spacing on this run — it shatters the shaping' });
      }
      if (cursiveOrComplex && n.wordSpacing && n.wordSpacing !== 'normal' && parseFloat(n.wordSpacing) !== 0) {
        findings.push({ ...base, rule: 'word-spacing', sev: 'render', evidence: { wordSpacing: n.wordSpacing }, fix: 'remove word-spacing on this run' });
      }
      if (SC.anyRtl(scripts) && n.direction !== 'rtl') {
        findings.push({ ...base, rule: 'wrong-direction', sev: 'render', evidence: { direction: n.direction }, fix: 'this RTL run is laid out ' + n.direction + ' — set direction:rtl / dir="rtl" on an ancestor' });
      }
      if (/none/i.test(n.fontVariantLigatures)) {
        findings.push({ ...base, rule: 'ligature-off', sev: 'render', evidence: { fontVariantLigatures: n.fontVariantLigatures }, fix: 'font-variant-ligatures:none disables the joins this script needs' });
      }

      // CDP: the ACTUAL rendered face over this text
      const platFonts = await platformFontsFor(n.selector);
      if (platFonts && platFonts.length) {
        const top = platFonts[0];
        if (SC.anyCursive(scripts) && familyIsLatinOnly(top.familyName) && top.glyphCount > 0) {
          findings.push({ ...base, rule: 'render-forced-latin', sev: 'render',
            evidence: { renderedFamily: top.familyName, glyphCount: top.glyphCount, declaredFontFamily: n.fontFamily },
            fix: `Chromium rendered ${top.glyphCount} glyph(s) of this Arabic run with the Latin face "${top.familyName}" — the font stack has no Arabic family; add one (e.g. "Noto Naskh Arabic")` });
        }
      }

      // HarfBuzz over the captured/reference face
      if (refFont) {
        try {
          const rf = await shapeCore.analyze(refFont, n.text, { fontName: opts.fontName || 'reference', label: n.text.slice(0, 24) });
          for (const f of rf) findings.push({ ...base, rule: f.rule, sev: 'render', evidence: f.evidence, fix: f.msg });
        } catch {}
      }
    }

    // shape captured webfonts against the page's Arabic to expose fake-Arabic fonts
    const allArabic = nodes.map(n => n.text).filter(t => SC.anyCursive(SC.detectScripts(t))).join(' ').slice(0, 200);
    if (allArabic) {
      for (const [u, bytes] of capturedFonts) {
        let fontBytes = bytes;
        if (/\.woff2(?:[?#]|$)/i.test(u)) { const w = woff2(); if (w) { try { fontBytes = Buffer.from(await w.decompress(bytes)); } catch { continue; } } else continue; }
        try {
          const j = await shapeCore.fontJoinsArabic(fontBytes);
          if (j.tofu || !j.joins) {
            findings.push({ url, selector: '(webfont)', text: u.split('/').pop(), scripts: ['Arabic'], rule: j.tofu ? 'render-fake-arabic-font' : 'render-broken-join', sev: 'render', evidence: { font: u, ...j }, fix: 'this downloaded webfont does no Arabic joining — do not use it for Arabic text' });
          }
        } catch {}
      }
    }

    const screenshot = opts.screenshot ? await page.screenshot({ fullPage: false }).then(b => b.toString('base64')).catch(() => null) : null;
    return { url, path: 'playwright', htmlMeta, nodes: nodes.length, fonts: [...capturedFonts.keys()], findings, screenshot };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── curl fallback (no Playwright) ───────────────────────────────────────────
function fetchText(url, { binary = false, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'kashida/0.4 (+https://kashida.ottospace.co)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, { binary, timeout }));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
  });
}

// decode HTML numeric + a few named entities so we can shape the real glyphs
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&mdash;/g, '—').replace(/&rarr;/g, '→')
    .replace(/&nbsp;/g, ' ').replace(/&ccedil;/g, 'ç');
}

/**
 * curlAnalyze(url, {font}) — no-browser fallback. Fetches HTML (+ linked CSS),
 * decodes entities, extracts complex-script runs, shapes them with the bundled
 * reference face, and reports tofu / declared-font issues / missing dir-lang.
 */
async function curlAnalyze(url, opts = {}) {
  const html = (await fetchText(url)).toString();
  const findings = [];
  const decoded = decodeEntities(html);

  // <html lang/dir>
  const htmlTag = (decoded.match(/<html[^>]*>/i) || [''])[0];
  const lang = (htmlTag.match(/\blang\s*=\s*["']?([\w-]+)/i) || [])[1] || '';
  const dir = (htmlTag.match(/\bdir\s*=\s*["']?(\w+)/i) || [])[1] || '';

  // strip tags → visible text, extract complex-script runs
  const visible = decoded.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const runs = shapeCore.extractRuns(visible, 400);
  const pageScripts = SC.detectScripts(runs.map(r => r.text).join(' '));

  if (pageScripts.length && SC.anyRtl(pageScripts) && !/rtl/i.test(dir)) {
    findings.push({ url, selector: 'html', text: '', scripts: pageScripts.map(s => s.name), rule: 'missing-dir', sev: 'render', evidence: { htmlDir: dir || '(none)' }, fix: 'RTL script present but <html dir> is not rtl' });
  }
  if (pageScripts.length && !lang) {
    findings.push({ url, selector: 'html', text: '', scripts: pageScripts.map(s => s.name), rule: 'missing-lang', sev: 'render', evidence: { htmlLang: '(none)' }, fix: 'set <html lang="…">' });
  }

  // linked stylesheets → declared font-family + letter-spacing on RTL/Arabic selectors
  const cssHrefs = [...decoded.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["']/gi)].map(m => m[1]);
  const kashida = require('./kashida-core');
  let cssBlob = '';
  for (const href of cssHrefs.slice(0, 8)) {
    let cssUrl; try { cssUrl = new URL(href, url).toString(); } catch { continue; }
    let css; try { css = (await fetchText(cssUrl)).toString(); } catch { continue; }
    cssBlob += '\n' + css;
    const res = kashida.scanSource('x.css', css);
    for (const f of res.findings) findings.push({ url: cssUrl, selector: '(css)', text: '', scripts: [], rule: f.rule, sev: 'flag', evidence: { line: f.line, from: f.from }, fix: f.msg });
  }
  // aggregate: page has a CURSIVE script but NOT ONE stylesheet names an
  // Arabic-capable family → Arabic renders in a Latin fallback (the classic
  // "forced-Latin" bug the render tier proves with getPlatformFontsForNode).
  if (SC.anyCursive(pageScripts)) {
    const ARABIC_FAM = /font-family[^;{}]*(?:arabic|cairo|tajawal|almarai|amiri|el\s*messiri|changa|markazi|lateef|scheherazade|reem\s*kufi|harmattan|readex|dubai|sakkal|geeza|aref\s*ruqaa|ibm\s*plex\s*sans\s*arabic|noto\s*naskh|noto\s*kufi)/i;
    if (!ARABIC_FAM.test(cssBlob) && !/<style[\s\S]*?(?:arabic|cairo|tajawal|amiri|noto\s*naskh)[\s\S]*?<\/style>/i.test(html)) {
      findings.push({ url, selector: '(stylesheets)', text: '', scripts: pageScripts.map(s => s.name), rule: 'no-arabic-font-declared', sev: 'render',
        evidence: { stylesheets: cssHrefs.length, arabicFamilyDeclared: false },
        fix: 'no Arabic-capable font-family is declared in any stylesheet — Arabic renders in a Latin fallback (tofu / ugly system fallback). Add an Arabic family to the body/root stack, e.g. font-family: "Noto Naskh Arabic","IBM Plex Sans Arabic", system-ui.' });
    }
  }

  // shape the page's complex-script runs with the reference face (tofu / marks)
  const refFont = opts.font || shapeCore.referenceFontBytes();
  if (refFont && await shapeCore.isAvailable()) {
    for (const r of runs.slice(0, 120)) {
      try {
        const rf = await shapeCore.analyze(refFont, r.text, { fontName: opts.fontName || 'Amiri (reference)', label: r.text.slice(0, 24) });
        for (const f of rf) findings.push({ url, selector: '(text-run)', text: r.text.slice(0, 60), scripts: SC.detectScripts(r.text).map(s => s.name), rule: f.rule, sev: 'render', evidence: f.evidence, fix: f.msg });
      } catch {}
    }
  }

  return { url, path: 'curl-fallback', htmlMeta: { lang, dir }, runs: runs.length, findings };
}

module.exports = {
  isAvailable, run, curlAnalyze, fetchText, decodeEntities, familyIsLatinOnly,
  classifyCursiveSplit, isSingleCursiveBox, cursiveLetterCount, CURSIVE_SPLIT_FIX,
};
