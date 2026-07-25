'use strict';
/*
 * kashida core — AST/PostCSS-verified, SHAPING-AWARE typography detection
 * (report-only). Static tier: zero heavy deps, never throws.
 *
 * A typography rule (letter-spacing, tight leading, tiny size, uppercase,
 * Latin-only font, ligature-off, bidi-override…) is only a *bug* when a script
 * that it breaks is actually in play. kashida established Arabic context and
 * flagged there. This version generalises to ALL world scripts via lib/scripts:
 *
 *   - the gate is now `complexScriptsIn(text)` — any non-Latin script we track
 *   - each cut-rule fires per-family: letter/word-spacing ONLY for
 *     `cursive || complex` (so Hebrew / Thaana / CJK never get a false
 *     letter-spacing flag — they don't join), bidi/vertical for any RTL, etc.
 *
 * kashida NEVER edits: typography is judgment. It reports where the script
 * would break and lets a human decide. (Formerly published as `arabitype`.)
 */
const path = require('path');
const SC = require('./scripts');
const { detectScripts, complexScriptsIn, BY_NAME, familyOf, namesOf } = SC;

let babelParser, babelTraverse, postcss;
try { babelParser = require('@babel/parser'); } catch { babelParser = null; }
try { const t = require('@babel/traverse'); babelTraverse = t.default || t; } catch { babelTraverse = null; }
try { postcss = require('postcss'); } catch { postcss = null; }

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const CSS_EXT = new Set(['.css', '.scss', '.less', '.pcss']);
const MARKUP_EXT = new Set(['.html', '.htm', '.vue', '.svelte', '.astro']);

const ARABIC = BY_NAME.get('Arabic');

const MSG = {
  tracking: 'letter-spacing / tracking-* shatters cursive joins & ligatures — remove it',
  leading: 'line-height too tight — Arabic tashkeel / Indic & CJK marks need leading ≥ 1.5',
  size: 'font-size too small for a complex script — body text should be ≥ 16px',
  upper: 'text-transform: uppercase has no effect on caseless scripts (Arabic/Indic/CJK) and hides bugs',
  textcase: 'text-transform: capitalize/lowercase has no effect on caseless scripts and can hide bugs',
  font: 'font stack has no Arabic family — add one (e.g. "Cairo","IBM Plex Sans Arabic")',
  ligature: 'disabling calt/liga/rlig/init/medi/fina (or font-variant-ligatures:none) turns OFF the joining & ligatures the script needs — remove it',
  bidi: 'unicode-bidi override corrupts the Unicode bidi algorithm for RTL text — use isolate/plaintext, never *-override',
  vertical: 'writing-mode: vertical-* mis-stacks horizontal RTL/complex text',
  zwnj: 'literal ZWNJ (U+200C) inside a cursive run breaks the join — verify it is intentional (Persian/Urdu use it deliberately; a stray one is a rendering bug)',
};

// Per-family message for the spacing (letter-spacing / word-spacing) cut.
function spacingMsg(scripts) {
  switch (familyOf(scripts)) {
    case 'cursive': return `letter-spacing / word-spacing shatters the cursive joins & ligatures of ${namesOf(scripts)} — keep it 0/normal`;
    case 'indic': return 'letter-spacing splits Indic conjuncts (e.g. क् + ष → क्ष) — remove it';
    case 'sea': return "SE-Asian scripts take no letter-spacing; and line-breaking needs a word segmenter (Intl.Segmenter / ICU), not split(' ')";
    case 'cjk': return 'prefer text-spacing over letter-spacing for CJK, and mind kinsoku line-break rules';
    default: return MSG.tracking;
  }
}

// ── which cut-rules fire for which script family ───────────────────────────
const spacingFires = (s) => SC.anyCursiveOrComplex(s);   // letter/word-spacing, tracking-*
const ligatureFires = (s) => SC.anyCursiveOrComplex(s);  // calt/liga/rlig 0, ligatures:none
const bidiFires = (s) => SC.anyRtl(s);                    // unicode-bidi override, writing-mode vertical
const zwnjFires = (s) => SC.anyCursive(s);               // literal ZWNJ in a join
const caseFires = (s) => s.length > 0;                    // uppercase/capitalize on caseless scripts
const leadingFires = (s) => s.length > 0;
const sizeFires = (s) => s.length > 0;
const fontFires = (s) => SC.anyCursive(s);                // the font allowlist is Arabic-specific

// ── lang="xx" / [lang=xx] / :lang(xx) → script ─────────────────────────────
function langToScript(lang) {
  const l = String(lang).toLowerCase();
  if (/^(ar|fa|ur|ps|ckb|sd|ug|pnb)\b/.test(l)) return BY_NAME.get('Arabic');   // Perso-Arabic
  if (/^(he|iw|yi|ji)\b/.test(l)) return BY_NAME.get('Hebrew');
  if (/^dv\b/.test(l)) return BY_NAME.get('Thaana');
  if (/^(hi|mr|ne|sa|kok|bho)\b/.test(l)) return BY_NAME.get('Devanagari');
  if (/^(bn|as)\b/.test(l)) return BY_NAME.get('Bengali');
  if (/^gu\b/.test(l)) return BY_NAME.get('Gujarati');
  if (/^ta\b/.test(l)) return BY_NAME.get('Tamil');
  if (/^te\b/.test(l)) return BY_NAME.get('Telugu');
  if (/^th\b/.test(l)) return BY_NAME.get('Thai');
  if (/^lo\b/.test(l)) return BY_NAME.get('Lao');
  if (/^km\b/.test(l)) return BY_NAME.get('Khmer');
  if (/^my\b/.test(l)) return BY_NAME.get('Myanmar');
  if (/^zh\b/.test(l)) return BY_NAME.get('Han');
  if (/^ja\b/.test(l)) return BY_NAME.get('Hiragana');
  if (/^ko\b/.test(l)) return BY_NAME.get('Hangul');
  return null;
}

function dedupeScripts(arr) {
  const seen = new Set(); const out = [];
  for (const s of arr) if (s && !seen.has(s.name)) { seen.add(s.name); out.push(s); }
  return out;
}

// ---------------------------------------------------------------------------
// Fonts — Arabic-font ALLOWLIST. Flag a stack only when it names a real Latin
// family AND has no Arabic family (so "Inter, Cairo" and "IBM Plex Sans Arabic,
// Inter" are both clean — no brittle lookahead false-positives).
// ---------------------------------------------------------------------------
const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  'fangsong', 'inherit', 'initial', 'revert', 'revert-layer', 'unset',
  '-apple-system', 'blinkmacsystemfont',
]);
const ARABIC_FONTS = new Set([
  'cairo', 'tajawal', 'almarai', 'amiri', 'rubik', 'el messiri', 'changa',
  'noto sans arabic', 'noto kufi arabic', 'noto naskh arabic', 'ibm plex sans arabic',
  'markazi text', 'lateef', 'scheherazade new', 'reem kufi', 'harmattan', 'mada',
  'katibeh', 'lalezar', 'jomhuria', 'aref ruqaa', 'readex pro', 'baloo bhaijaan 2',
]);
function fontStackNeedsArabic(value, extra) {
  const families = value.split(',')
    .map(f => f.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean);
  if (!families.length) return false;
  const hasArabic = families.some(f => ARABIC_FONTS.has(f) || f.includes('arabic') || (extra && extra.has(f)));
  const hasNamed = families.some(f => !GENERIC_FONTS.has(f));
  return hasNamed && !hasArabic;
}

// ---------------------------------------------------------------------------
// Value interpreters (shared by Tailwind arbitrary values, CSS, JS inline)
// ---------------------------------------------------------------------------
const LEN = /^(-?\d*\.?\d+)(px|rem|em|pt)$/;
function isZeroSpacing(v) { return /^(?:0(?:px|em|rem|%)?|normal)$/i.test(String(v).trim()); }
function nonZeroSpacing(v) {
  if (typeof v === 'number') return v !== 0;
  return !isZeroSpacing(v);
}
function smallLen(v) { // < 16px / < 1rem-em — v: number (→px) or "13px"/"0.8rem"
  if (typeof v === 'number') return v > 0 && v < 16;
  const m = LEN.exec(String(v).trim());
  if (!m) return false;
  const n = parseFloat(m[1]);
  return (m[2] === 'px' || m[2] === 'pt') ? n > 0 && n < 16 : n > 0 && n < 1;
}
function tightLH(v) { // < 1.5 unitless/em, < 150%
  if (typeof v === 'number') return v > 0 && v < 1.5; // DOM unitless multiplier
  const s = String(v).trim();
  let m = /^(\d*\.?\d+)(?:em)?$/.exec(s); if (m) return parseFloat(m[1]) < 1.5;
  m = /^(\d*\.?\d+)%$/.exec(s); if (m) return parseFloat(m[1]) < 150;
  return false;
}
// font-feature-settings / Tailwind arbitrary: does it turn OFF a join/ligature
// feature? e.g.  "liga" 0 ,  'calt' 0 ,  rlig 0  (underscores = spaces in TW).
function disablesJoin(v) {
  const s = String(v).replace(/_/g, ' ');
  return /["']?\b(?:calt|liga|rlig|init|medi|fina|dlig|clig)\b["']?\s+0(?!\d)/i.test(s);
}
const isOverrideBidi = (v) => /override/i.test(String(v));
const isVertical = (v) => /^vertical-/i.test(String(v).trim());
const isLigNone = (v) => /^none$/i.test(String(v).trim());

// ---------------------------------------------------------------------------
// Tailwind token classifier — returns { rule, msg } or null.
// `scripts` is the element's script context; gates + messages are per-family.
// ---------------------------------------------------------------------------
// Strip leading Tailwind variant segments (`md:`, `hover:`, `[&:hover]:`) WITHOUT
// splitting on the colon *inside* an arbitrary-property utility like
// `[word-spacing:5px]`. Returns the bare utility.
function stripVariants(tok) {
  let u = tok;
  for (;;) {
    const m = /^(?:[^\s:[\]]+|\[[^\]]*\]):(?=.)/.exec(u);
    if (!m) break;
    u = u.slice(m[0].length);
  }
  return u;
}

function twArabicFlag(tok, scripts) {
  if (!scripts) scripts = [ARABIC];
  let u = stripVariants(tok);
  if (u.startsWith('!')) u = u.slice(1);
  if (u === 'uppercase') return caseFires(scripts) ? { rule: 'uppercase', msg: MSG.upper } : null;
  if (u === 'capitalize' || u === 'lowercase') return caseFires(scripts) ? { rule: 'text-transform', msg: MSG.textcase } : null;
  let m;
  if ((m = /^-?tracking-(.+)$/.exec(u))) {
    if (!spacingFires(scripts)) return null;
    const val = m[1];
    if (val === 'normal') return null;
    const arb = /^\[(.+)\]$/.exec(val);
    if (arb) return isZeroSpacing(arb[1]) ? null : { rule: 'letter-spacing', msg: spacingMsg(scripts) };
    return { rule: 'letter-spacing', msg: spacingMsg(scripts) };
  }
  if ((m = /^leading-(.+)$/.exec(u))) {
    if (!leadingFires(scripts)) return null;
    const val = m[1];
    if (val === 'none' || val === 'tight' || val === 'snug') return { rule: 'tight-leading', msg: MSG.leading };
    const arb = /^\[(.+)\]$/.exec(val);
    if (arb) return tightLH(arb[1]) ? { rule: 'tight-leading', msg: MSG.leading } : null;
    return null;
  }
  if ((m = /^text-(.+)$/.exec(u))) {
    if (!sizeFires(scripts)) return null;
    const val = m[1];
    if (val === 'xs' || val === 'sm') return { rule: 'small-size', msg: MSG.size };
    const arb = /^\[(.+)\]$/.exec(val);
    if (arb) return smallLen(arb[1]) ? { rule: 'small-size', msg: MSG.size } : null;
    return null;
  }
  // Arbitrary-property utilities: [word-spacing:…] [font-feature-settings:…] etc.
  if ((m = /^\[word-spacing:(.+)\]$/.exec(u))) {
    if (!spacingFires(scripts)) return null;
    return isZeroSpacing(m[1].replace(/_/g, '')) ? null : { rule: 'word-spacing', msg: spacingMsg(scripts) };
  }
  if ((m = /^\[font-feature-settings:(.+)\]$/.exec(u))) {
    if (!ligatureFires(scripts)) return null;
    return disablesJoin(m[1]) ? { rule: 'ligature-off', msg: MSG.ligature } : null;
  }
  if ((m = /^\[font-variant-ligatures:(.+)\]$/.exec(u))) {
    if (!ligatureFires(scripts)) return null;
    return isLigNone(m[1]) ? { rule: 'ligature-off', msg: MSG.ligature } : null;
  }
  if ((m = /^\[unicode-bidi:(.+)\]$/.exec(u))) {
    if (!bidiFires(scripts)) return null;
    return isOverrideBidi(m[1]) ? { rule: 'bidi-override', msg: MSG.bidi } : null;
  }
  if ((m = /^\[writing-mode:(.+)\]$/.exec(u))) {
    if (!bidiFires(scripts)) return null;
    return isVertical(m[1]) ? { rule: 'vertical-writing', msg: MSG.vertical } : null;
  }
  return null;
}

// class-combining helpers whose string args are class lists
const CLASS_UTILS = new Set(['cn', 'clsx', 'classnames', 'classNames', 'cx', 'cva', 'tv', 'tw', 'twMerge', 'twJoin']);
const CLASS_TAGS = new Set(['tw', 'css']);

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// ZWNJ (U+200C) sitting inside a cursive run — a stray one breaks the join.
// Runs for every file type; gets filtered by kashida-ignore / disable later.
// ---------------------------------------------------------------------------
const CURSIVE_RE = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Adlam}]/u;
const ZWNJ_NEAR = /(?:[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Adlam}]‌|‌[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Adlam}])/gu;
function scanZwnj(src, findings) {
  if (src.indexOf('‌') === -1) return;
  ZWNJ_NEAR.lastIndex = 0;
  let m; const seenLines = new Set();
  while ((m = ZWNJ_NEAR.exec(src)) !== null) {
    const line = lineAt(src, m.index);
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    findings.push({ rule: 'zwnj', sev: 'flag', line, from: 'U+200C (ZWNJ)', to: '', msg: MSG.zwnj });
  }
}

// ---------------------------------------------------------------------------
// JS / TS / JSX / TSX scan (Babel) — every check gated on element script context
// ---------------------------------------------------------------------------
function babelPlugins(ext) {
  const p = [];
  if (ext === '.ts' || ext === '.tsx') p.push('typescript');
  if (ext !== '.ts') p.push('jsx');
  return p;
}

function langDirScripts(openingEl) {
  const attrs = openingEl.attributes || [];
  const getVal = (a) => {
    if (a.type !== 'JSXAttribute' || !a.value) return null;
    if (a.value.type === 'StringLiteral') return a.value.value;
    if (a.value.type === 'JSXExpressionContainer' && a.value.expression && a.value.expression.type === 'StringLiteral') return a.value.expression.value;
    return null;
  };
  const out = []; let hasRtlDir = false;
  for (const a of attrs) {
    const nm = a.name && a.name.name; const val = getVal(a);
    if (val == null) continue;
    if (nm === 'lang') { const sc = langToScript(val); if (sc) out.push(sc); }
    if (nm === 'dir' && /^rtl$/i.test(val)) hasRtlDir = true;
  }
  if (!out.length && hasRtlDir) out.push(ARABIC);
  return out;
}

function scanJs(file, src, ext, findings, ctx) {
  if (!babelParser || !babelTraverse) return;
  let ast;
  try {
    ast = babelParser.parse(src, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      plugins: babelPlugins(ext),
    });
  } catch { return; } // parse failed → stay silent (no false positives)

  const push = (rule, line, from, msg) => findings.push({ rule, sev: 'flag', line, from, to: '', msg });
  const cache = new WeakMap();

  const elScripts = (elPath) => {
    const node = elPath.node;
    if (cache.has(node)) return cache.get(node);
    let res = detectScripts(src.slice(node.start, node.end));
    let cur = elPath;
    while (cur) {
      if (cur.isJSXElement && cur.isJSXElement()) {
        const ld = langDirScripts(cur.node.openingElement);
        if (ld.length) res = res.concat(ld);
      }
      cur = cur.parentPath;
    }
    res = dedupeScripts(res);
    cache.set(node, res);
    return res;
  };
  const classScripts = (p) => {
    const el = p.findParent(pp => pp.isJSXElement && pp.isJSXElement());
    return el ? elScripts(el) : [];
  };

  const utilCallee = (callee) => {
    if (!callee) return false;
    if (callee.type === 'Identifier') return CLASS_UTILS.has(callee.name);
    if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') return CLASS_UTILS.has(callee.property.name);
    return false;
  };
  const utilTag = (tag) => tag && tag.type === 'Identifier' && CLASS_TAGS.has(tag.name);

  const isClassContext = (p) => {
    let n = p.parentPath;
    if (n && n.isJSXExpressionContainer && n.isJSXExpressionContainer()) n = n.parentPath;
    if (n && n.isJSXAttribute && n.isJSXAttribute()) {
      const an = n.node.name && n.node.name.name;
      if (an === 'className' || an === 'class') return true;
    }
    return !!p.findParent(pp =>
      (pp.isCallExpression && pp.isCallExpression() && utilCallee(pp.node.callee)) ||
      (pp.isTaggedTemplateExpression && pp.isTaggedTemplateExpression() && utilTag(pp.node.tag)));
  };

  const collectClass = (raw, line, p) => {
    const scripts = classScripts(p);
    if (!scripts.length) return;
    for (const tok of raw.split(/\s+/)) {
      if (!tok || tok.includes('${') || tok.includes('{') || tok.includes('}')) continue;
      const f = twArabicFlag(tok, scripts);
      if (f) push(f.rule, line, tok, f.msg);
    }
  };

  const numVal = (v) => {
    if (v.type === 'StringLiteral') return v.value;
    if (v.type === 'NumericLiteral') return v.value;
    if (v.type === 'UnaryExpression' && v.operator === '-' && v.argument.type === 'NumericLiteral') return -v.argument.value;
    return undefined;
  };

  const styleObject = (objExpr, scripts) => {
    if (!scripts.length) return;
    for (const prop of objExpr.properties) {
      if (prop.type !== 'ObjectProperty' || prop.computed) continue;
      const k = prop.key;
      const name = k.type === 'Identifier' ? k.name : (k.type === 'StringLiteral' ? k.value : null);
      if (!name) continue;
      const v = prop.value;
      const line = v.loc.start.line;
      const val = numVal(v);
      const disp = v.type === 'StringLiteral' ? v.value : String(val);
      const str = v.type === 'StringLiteral' ? v.value : null;
      if (name === 'letterSpacing' && val !== undefined && nonZeroSpacing(val) && spacingFires(scripts)) push('letter-spacing', line, `letterSpacing: ${disp}`, spacingMsg(scripts));
      else if (name === 'wordSpacing' && val !== undefined && nonZeroSpacing(val) && spacingFires(scripts)) push('word-spacing', line, `wordSpacing: ${disp}`, spacingMsg(scripts));
      else if (name === 'lineHeight' && val !== undefined && tightLH(val) && leadingFires(scripts)) push('tight-leading', line, `lineHeight: ${disp}`, MSG.leading);
      else if (name === 'fontSize' && val !== undefined && smallLen(val) && sizeFires(scripts)) push('small-size', line, `fontSize: ${disp}`, MSG.size);
      else if (name === 'textTransform' && str === 'uppercase' && caseFires(scripts)) push('uppercase', line, 'textTransform: uppercase', MSG.upper);
      else if (name === 'textTransform' && (str === 'capitalize' || str === 'lowercase') && caseFires(scripts)) push('text-transform', line, `textTransform: ${str}`, MSG.textcase);
      else if (name === 'fontFeatureSettings' && str && disablesJoin(str) && ligatureFires(scripts)) push('ligature-off', line, `fontFeatureSettings: ${str}`, MSG.ligature);
      else if (name === 'fontVariantLigatures' && str && isLigNone(str) && ligatureFires(scripts)) push('ligature-off', line, 'fontVariantLigatures: none', MSG.ligature);
      else if (name === 'unicodeBidi' && str && isOverrideBidi(str) && bidiFires(scripts)) push('bidi-override', line, `unicodeBidi: ${str}`, MSG.bidi);
      else if (name === 'writingMode' && str && isVertical(str) && bidiFires(scripts)) push('vertical-writing', line, `writingMode: ${str}`, MSG.vertical);
      else if (name === 'fontFamily' && str && fontStackNeedsArabic(str, ctx.extraArabic) && fontFires(scripts)) push('latin-font-stack', line, str, MSG.font);
    }
  };

  babelTraverse(ast, {
    StringLiteral(p) {
      if (isClassContext(p)) collectClass(p.node.value, p.node.loc.start.line, p);
    },
    TemplateElement(p) {
      const tl = p.parentPath;
      if (!tl || !tl.isTemplateLiteral()) return;
      if (isClassContext(tl)) collectClass(p.node.value.raw, p.node.loc.start.line, tl);
    },
    JSXAttribute(p) {
      if (p.node.name.name !== 'style') return;
      const v = p.node.value;
      if (!v || v.type !== 'JSXExpressionContainer' || !v.expression || v.expression.type !== 'ObjectExpression') return;
      const el = p.findParent(pp => pp.isJSXElement && pp.isJSXElement());
      styleObject(v.expression, el ? elScripts(el) : []);
    },
  });
}

// ---------------------------------------------------------------------------
// CSS scan (PostCSS) — gated on the script context of the rule's selectors
// ---------------------------------------------------------------------------
function selectorScripts(selector) {
  const out = [];
  const langHints = [
    ...selector.matchAll(/\[lang[~|^$*]?=["']?([A-Za-z-]+)/g),
    ...selector.matchAll(/:lang\(\s*["']?([A-Za-z-]+)/g),
  ];
  for (const m of langHints) { const sc = langToScript(m[1]); if (sc) out.push(sc); }
  if (/\.(?:ar|arabic)\b/.test(selector)) out.push(BY_NAME.get('Arabic'));
  if (/\.(?:he|hebrew)\b/.test(selector)) out.push(BY_NAME.get('Hebrew'));
  // generic RTL selector with no language → assume Arabic (kashida is Arabic-first)
  if (!out.length && /\[dir[~|^$*]?=["']?rtl\b|:dir\(\s*rtl\b/.test(selector)) out.push(ARABIC);
  for (const sc of detectScripts(selector)) out.push(sc);
  return dedupeScripts(out);
}

function ruleScripts(decl) {
  let out = [];
  let p = decl.parent;
  while (p) {
    if (p.type === 'rule' && p.selector) out = out.concat(selectorScripts(p.selector));
    p = p.parent;
  }
  out = out.concat(detectScripts(decl.value));
  return dedupeScripts(out);
}

function scanCss(file, src, findings, ctx) {
  if (!postcss) return;
  let root;
  try { root = postcss.parse(src); } catch { return; }
  const push = (rule, line, from, msg) => findings.push({ rule, sev: 'flag', line, from, to: '', msg });
  root.walkDecls(decl => {
    const scripts = ruleScripts(decl);
    if (!scripts.length) return;
    const prop = decl.prop.toLowerCase();
    const v = decl.value.trim();
    const line = decl.source && decl.source.start ? decl.source.start.line : 1;
    if (prop === 'letter-spacing') { if (nonZeroSpacing(v) && spacingFires(scripts)) push('letter-spacing', line, `letter-spacing: ${v}`, spacingMsg(scripts)); }
    else if (prop === 'word-spacing') { if (nonZeroSpacing(v) && spacingFires(scripts)) push('word-spacing', line, `word-spacing: ${v}`, spacingMsg(scripts)); }
    else if (prop === 'line-height') { if (tightLH(v) && leadingFires(scripts)) push('tight-leading', line, `line-height: ${v}`, MSG.leading); }
    else if (prop === 'font-size') { if (smallLen(v) && sizeFires(scripts)) push('small-size', line, `font-size: ${v}`, MSG.size); }
    else if (prop === 'text-transform') {
      if (/^uppercase$/i.test(v) && caseFires(scripts)) push('uppercase', line, 'text-transform: uppercase', MSG.upper);
      else if (/^(capitalize|lowercase)$/i.test(v) && caseFires(scripts)) push('text-transform', line, `text-transform: ${v}`, MSG.textcase);
    }
    else if (prop === 'font-feature-settings') { if (disablesJoin(v) && ligatureFires(scripts)) push('ligature-off', line, `font-feature-settings: ${v}`, MSG.ligature); }
    else if (prop === 'font-variant-ligatures') { if (isLigNone(v) && ligatureFires(scripts)) push('ligature-off', line, `font-variant-ligatures: ${v}`, MSG.ligature); }
    else if (prop === 'unicode-bidi') { if (isOverrideBidi(v) && bidiFires(scripts)) push('bidi-override', line, `unicode-bidi: ${v}`, MSG.bidi); }
    else if (prop === 'writing-mode') { if (isVertical(v) && bidiFires(scripts)) push('vertical-writing', line, `writing-mode: ${v}`, MSG.vertical); }
    else if (prop === 'font-family') { if (fontStackNeedsArabic(decl.value, ctx.extraArabic) && fontFires(scripts)) push('latin-font-stack', line, v, MSG.font); }
  });
}

// ---------------------------------------------------------------------------
// Markup scan (.html/.vue/.svelte/.astro) — file/tag/nearby script gate
// ---------------------------------------------------------------------------
const MARKUP_CLASS_RE = /\b(?:class|className)\s*=\s*(["'])((?:(?!\1).)*)\1/g;
function markupHtmlScripts(src) {
  const out = [];
  let m = /<html[^>]*\blang\s*=\s*["']?([A-Za-z-]+)/i.exec(src);
  if (m) { const sc = langToScript(m[1]); if (sc) out.push(sc); }
  if (/<html[^>]*\bdir\s*=\s*["']?rtl\b/i.test(src) || /<body[^>]*\bdir\s*=\s*["']?rtl\b/i.test(src)) { if (!out.length) out.push(ARABIC); }
  return out;
}
function scanMarkup(file, src, findings, ctx) {
  const htmlScripts = markupHtmlScripts(src);
  const push = (rule, line, from, msg) => findings.push({ rule, sev: 'flag', line, from, to: '', msg });
  let m;
  MARKUP_CLASS_RE.lastIndex = 0;
  while ((m = MARKUP_CLASS_RE.exec(src)) !== null) {
    const raw = m[2];
    if (raw.includes('{') || raw.includes('}') || raw.includes('<') || raw.includes('$')) continue;
    const attrStart = m.index;
    const tagStart = src.lastIndexOf('<', attrStart);
    const gt = src.indexOf('>', attrStart);
    const tagText = tagStart >= 0 && gt >= 0 ? src.slice(tagStart, gt + 1) : '';
    let scripts = htmlScripts.slice();
    const lm = /\blang\s*=\s*["']?([A-Za-z-]+)/i.exec(tagText);
    if (lm) { const sc = langToScript(lm[1]); if (sc) scripts.push(sc); }
    if (/\bdir\s*=\s*["']?rtl\b/i.test(tagText) && !scripts.length) scripts.push(ARABIC);
    const win = gt >= 0 ? src.slice(gt + 1, Math.min(src.length, gt + 1 + 400)) : '';
    scripts = scripts.concat(detectScripts((win.split('<')[0] || '')));
    scripts = dedupeScripts(scripts);
    if (!scripts.length) continue;
    const valStart = m.index + m[0].length - 1 - raw.length;
    const line = lineAt(src, valStart);
    for (const tok of raw.split(/\s+/)) {
      if (!tok) continue;
      const f = twArabicFlag(tok, scripts);
      if (f) push(f.rule, line, tok, f.msg);
    }
  }
}

// ---------------------------------------------------------------------------
// // kashida-ignore  +  config disable
// ---------------------------------------------------------------------------
function ignoredLines(src) {
  const lines = src.split('\n');
  const ig = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (/kashida-ignore-file/.test(lines[i])) return 'file';
    if (/kashida-ignore\b/.test(lines[i])) { ig.add(i + 1); ig.add(i + 2); } // this line + next
  }
  return ig;
}

// ---------------------------------------------------------------------------
// Sort + dedup
// ---------------------------------------------------------------------------
function sortFindings(findings) {
  findings.sort((a, b) =>
    a.line - b.line || a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const seen = new Set();
  return findings.filter(f => {
    const k = [f.rule, f.line, f.from, f.to].join('|');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------
function scanSource(file, src, opts = {}) {
  const ext = path.extname(file).toLowerCase();
  const ig = ignoredLines(src);
  if (ig === 'file') return { findings: [] };
  const ctx = {
    extraArabic: new Set((opts.arabicFonts || []).map(s => String(s).toLowerCase())),
    disabled: new Set(opts.disable || []),
  };
  let findings = [];
  if (JS_EXT.has(ext)) scanJs(file, src, ext, findings, ctx);
  else if (CSS_EXT.has(ext)) scanCss(file, src, findings, ctx);
  else if (MARKUP_EXT.has(ext)) scanMarkup(file, src, findings, ctx);
  else return { findings: [] };
  scanZwnj(src, findings);
  findings = sortFindings(findings).filter(f => !ig.has(f.line) && !ctx.disabled.has(f.rule));
  return { findings };
}

module.exports = {
  scanSource,
  twArabicFlag, fontStackNeedsArabic, smallLen, tightLH, nonZeroSpacing,
  disablesJoin, langToScript, selectorScripts, spacingMsg,
  JS_EXT, CSS_EXT, MARKUP_EXT,
};
