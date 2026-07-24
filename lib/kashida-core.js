'use strict';
/*
 * kashida core — AST/PostCSS-verified Arabic-typography detection (report-only).
 *
 * The whole value prop: a typography rule (letter-spacing, tight leading, tiny
 * size, uppercase, Latin-only font) is only a *bug* when Arabic is actually in
 * play. So every check is GATED on Arabic context, established by any of:
 *   - Arabic-script codepoints (\p{Script=Arabic}) in the element's subtree/decl
 *   - lang="ar" / dir="rtl" on the element or an ancestor
 *   - an [lang=ar] / .ar / .arabic / [dir=rtl] / :lang(ar) selector (CSS)
 * Without an Arabic signal we stay silent — a pure-English file → zero findings.
 *
 * kashida NEVER edits: typography is judgment (a Latin heading may WANT
 * tracking). It reports where Arabic would break and lets a human decide.
 */
const path = require('path');

let babelParser, babelTraverse, postcss;
try { babelParser = require('@babel/parser'); } catch { babelParser = null; }
try { const t = require('@babel/traverse'); babelTraverse = t.default || t; } catch { babelTraverse = null; }
try { postcss = require('postcss'); } catch { postcss = null; }

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const CSS_EXT = new Set(['.css', '.scss', '.less', '.pcss']);
const MARKUP_EXT = new Set(['.html', '.htm', '.vue', '.svelte', '.astro']);

const MSG = {
  tracking: 'letter-spacing / tracking-* shatters Arabic ligatures — remove it for Arabic text',
  leading: 'line-height too tight — Arabic tashkeel (diacritics) needs leading ≥ 1.5',
  size: 'font-size too small for Arabic — body Arabic should be ≥ 16px',
  upper: 'text-transform: uppercase has no effect on Arabic (no case) and can hide bugs',
  font: 'font stack has no Arabic family — add one (e.g. "Cairo","IBM Plex Sans Arabic")',
};

// ---------------------------------------------------------------------------
// Arabic detection
// ---------------------------------------------------------------------------
const ARABIC_RE = /\p{Script=Arabic}/u;
// Selectors that target Arabic text (CSS side).
const ARABIC_SEL = /\.(?:ar|arabic)\b|\[lang[~|^$*]?=["']?ar\b|\[dir[~|^$*]?=["']?rtl\b|:lang\(\s*ar\b|:dir\(\s*rtl\b|\p{Script=Arabic}/u;

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

// ---------------------------------------------------------------------------
// Tailwind token classifier — returns { rule, msg } or null
// ---------------------------------------------------------------------------
function twArabicFlag(tok) {
  const ci = tok.lastIndexOf(':');
  let u = ci === -1 ? tok : tok.slice(ci + 1);
  if (u.startsWith('!')) u = u.slice(1);
  if (u === 'uppercase') return { rule: 'uppercase', msg: MSG.upper };
  let m;
  if ((m = /^-?tracking-(.+)$/.exec(u))) {
    const val = m[1];
    if (val === 'normal') return null;
    const arb = /^\[(.+)\]$/.exec(val);
    if (arb) return isZeroSpacing(arb[1]) ? null : { rule: 'letter-spacing', msg: MSG.tracking };
    return { rule: 'letter-spacing', msg: MSG.tracking };
  }
  if ((m = /^leading-(.+)$/.exec(u))) {
    const val = m[1];
    if (val === 'none' || val === 'tight' || val === 'snug') return { rule: 'tight-leading', msg: MSG.leading };
    const arb = /^\[(.+)\]$/.exec(val);
    if (arb) return tightLH(arb[1]) ? { rule: 'tight-leading', msg: MSG.leading } : null;
    return null;
  }
  if ((m = /^text-(.+)$/.exec(u))) {
    const val = m[1];
    if (val === 'xs' || val === 'sm') return { rule: 'small-size', msg: MSG.size };
    const arb = /^\[(.+)\]$/.exec(val);
    if (arb) return smallLen(arb[1]) ? { rule: 'small-size', msg: MSG.size } : null;
    return null;
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
// JS / TS / JSX / TSX scan (Babel) — every check gated on element Arabic context
// ---------------------------------------------------------------------------
function babelPlugins(ext) {
  const p = [];
  if (ext === '.ts' || ext === '.tsx') p.push('typescript');
  if (ext !== '.ts') p.push('jsx');
  return p;
}

function langDirAttr(openingEl) {
  for (const a of (openingEl.attributes || [])) {
    if (a.type !== 'JSXAttribute' || !a.value) continue;
    const nm = a.name && a.name.name;
    let val = null;
    if (a.value.type === 'StringLiteral') val = a.value.value;
    else if (a.value.type === 'JSXExpressionContainer' && a.value.expression && a.value.expression.type === 'StringLiteral') val = a.value.expression.value;
    if (val == null) continue;
    if (nm === 'lang' && /^ar\b/i.test(val)) return true;
    if (nm === 'dir' && /^rtl$/i.test(val)) return true;
  }
  return false;
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

  const elArabic = (elPath) => {
    const node = elPath.node;
    if (cache.has(node)) return cache.get(node);
    let res = ARABIC_RE.test(src.slice(node.start, node.end));
    if (!res) {
      let cur = elPath;
      while (cur) {
        if (cur.isJSXElement && cur.isJSXElement() && langDirAttr(cur.node.openingElement)) { res = true; break; }
        cur = cur.parentPath;
      }
    }
    cache.set(node, res);
    return res;
  };
  const classArabic = (p) => {
    const el = p.findParent(pp => pp.isJSXElement && pp.isJSXElement());
    return el ? elArabic(el) : false;
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
    if (!classArabic(p)) return;
    for (const tok of raw.split(/\s+/)) {
      if (!tok || tok.includes('${') || tok.includes('{') || tok.includes('}')) continue;
      const f = twArabicFlag(tok);
      if (f) push(f.rule, line, tok, f.msg);
    }
  };

  const numVal = (v) => {
    if (v.type === 'StringLiteral') return v.value;
    if (v.type === 'NumericLiteral') return v.value;
    if (v.type === 'UnaryExpression' && v.operator === '-' && v.argument.type === 'NumericLiteral') return -v.argument.value;
    return undefined;
  };

  const styleObject = (objExpr, arabic) => {
    if (!arabic) return;
    for (const prop of objExpr.properties) {
      if (prop.type !== 'ObjectProperty' || prop.computed) continue;
      const k = prop.key;
      const name = k.type === 'Identifier' ? k.name : (k.type === 'StringLiteral' ? k.value : null);
      if (!name) continue;
      const v = prop.value;
      const line = v.loc.start.line;
      const val = numVal(v);
      const disp = v.type === 'StringLiteral' ? v.value : String(val);
      if (name === 'letterSpacing' && val !== undefined && nonZeroSpacing(val)) push('letter-spacing', line, `letterSpacing: ${disp}`, MSG.tracking);
      else if (name === 'lineHeight' && val !== undefined && tightLH(val)) push('tight-leading', line, `lineHeight: ${disp}`, MSG.leading);
      else if (name === 'fontSize' && val !== undefined && smallLen(val)) push('small-size', line, `fontSize: ${disp}`, MSG.size);
      else if (name === 'textTransform' && v.type === 'StringLiteral' && v.value === 'uppercase') push('uppercase', line, 'textTransform: uppercase', MSG.upper);
      else if (name === 'fontFamily' && v.type === 'StringLiteral' && fontStackNeedsArabic(v.value, ctx.extraArabic)) push('latin-font-stack', line, v.value, MSG.font);
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
      styleObject(v.expression, el ? elArabic(el) : false);
    },
  });
}

// ---------------------------------------------------------------------------
// CSS scan (PostCSS) — gated on an Arabic-targeting selector
// ---------------------------------------------------------------------------
function ruleIsArabic(decl) {
  let p = decl.parent;
  while (p) {
    if (p.type === 'rule' && p.selector && ARABIC_SEL.test(p.selector)) return true;
    p = p.parent;
  }
  return false;
}

function scanCss(file, src, findings, ctx) {
  if (!postcss) return;
  let root;
  try { root = postcss.parse(src); } catch { return; }
  const push = (rule, line, from, msg) => findings.push({ rule, sev: 'flag', line, from, to: '', msg });
  root.walkDecls(decl => {
    if (!ruleIsArabic(decl)) return;
    const prop = decl.prop.toLowerCase();
    const v = decl.value.trim();
    const line = decl.source && decl.source.start ? decl.source.start.line : 1;
    if (prop === 'letter-spacing') { if (nonZeroSpacing(v)) push('letter-spacing', line, `letter-spacing: ${v}`, MSG.tracking); }
    else if (prop === 'line-height') { if (tightLH(v)) push('tight-leading', line, `line-height: ${v}`, MSG.leading); }
    else if (prop === 'font-size') { if (smallLen(v)) push('small-size', line, `font-size: ${v}`, MSG.size); }
    else if (prop === 'text-transform') { if (/^uppercase$/i.test(v)) push('uppercase', line, 'text-transform: uppercase', MSG.upper); }
    else if (prop === 'font-family') { if (fontStackNeedsArabic(decl.value, ctx.extraArabic)) push('latin-font-stack', line, v, MSG.font); }
  });
}

// ---------------------------------------------------------------------------
// Markup scan (.html/.vue/.svelte/.astro) — file/tag/nearby Arabic gate
// ---------------------------------------------------------------------------
const MARKUP_CLASS_RE = /\b(?:class|className)\s*=\s*(["'])((?:(?!\1).)*)\1/g;
function scanMarkup(file, src, findings, ctx) {
  const htmlArabic =
    /<html[^>]*\b(?:lang\s*=\s*["']?ar\b|dir\s*=\s*["']?rtl\b)/i.test(src) ||
    /<body[^>]*\bdir\s*=\s*["']?rtl\b/i.test(src);
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
    const tagArabic = /\blang\s*=\s*["']?ar\b/i.test(tagText) || /\bdir\s*=\s*["']?rtl\b/i.test(tagText);
    const win = gt >= 0 ? src.slice(gt + 1, Math.min(src.length, gt + 1 + 400)) : '';
    const winArabic = ARABIC_RE.test((win.split('<')[0] || ''));
    if (!(htmlArabic || tagArabic || winArabic)) continue;
    const valStart = m.index + m[0].length - 1 - raw.length;
    const line = lineAt(src, valStart);
    for (const tok of raw.split(/\s+/)) {
      if (!tok) continue;
      const f = twArabicFlag(tok);
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
  findings = sortFindings(findings).filter(f => !ig.has(f.line) && !ctx.disabled.has(f.rule));
  return { findings };
}

module.exports = {
  scanSource,
  twArabicFlag, fontStackNeedsArabic, smallLen, tightLH, nonZeroSpacing,
  JS_EXT, CSS_EXT, MARKUP_EXT,
};
