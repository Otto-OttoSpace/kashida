# kashida

**Catch the typography mistakes that quietly break COMPLEX-SCRIPT rendering — Arabic & the RTL-cursive family, Indic, SE-Asian, CJK, Hebrew — but only where such a script is actually in play.**

> Formerly published as `arabitype`. Same tool, now **shaping-aware and multi-script**: it proves a complex script is present before it flags anything (a pure-Latin file reports **zero**), and it gates every rule *per family* — so Hebrew and CJK never get a false `letter-spacing` flag (they don't join), while Arabic and Indic do.

Arabic (`كَشِيدَة`) is a connected, cursive script with diacritics (tashkeel). The Latin-default styling AI codegen produces *breaks* it: `letter-spacing` shatters the joins, disabling `calt`/`rlig` kills the ligatures, tight `line-height` crushes the tashkeel, Latin-only fonts render it as tofu. **kashida** flags these — and *only* where the script that they break is present.

```bash
npx kashida .                       # static tier — report issues
npx kashida . --json                # machine-readable (CI)
npx kashida . --check               # exit non-zero if anything found (CI)
npx kashida . --render              # + HarfBuzz: shape the text, prove no tofu / fake-Arabic-font
npx kashida . --render --font f.ttf # shape against a specific font file
npx kashida --url https://site/ar/  # live: headless Chromium inspects the RENDERED page
npx kashida . --init-rules          # write typography rules for your AI agent
```

## Three tiers

1. **static** (default, zero heavy deps, never throws) — AST/PostCSS. Catches `letter-spacing`/`word-spacing`/`tracking-*`, tight `line-height`, tiny sizes, `uppercase`/`capitalize`, Latin-only fonts, **ligature-off** (`font-feature-settings "calt"/"liga"/"rlig"/"init"/"medi"/"fina" 0`, `font-variant-ligatures:none`), **bidi-override**, **vertical writing-mode** on RTL, and a **stray literal ZWNJ** inside a cursive word.
2. **`--render`** (optional deps `harfbuzzjs` + `fontkit`) — HarfBuzz ground truth: shapes the text and reports **tofu** (a glyph shaped to `.notdef`), **fake-Arabic-font** (a face that does no Arabic joining — normal output == joining-disabled output), and **mark-collision** (a combining mark placed at `dx=0,dy=0`). Ships a bundled reference Arabic face (Amiri).
3. **`--url`** (optional deps `playwright` + `wawoff2`) — render-time: launches Chromium, waits for webfonts, walks every visible text node, and uses CDP `CSS.getPlatformFontsForNode` to prove the **actual** face the browser used (a Latin family with `glyphCount>0` over Arabic = forced-Latin). Falls back to a curl+shape analysis when Playwright isn't installed.

## Scripts it understands

RTL-cursive **Arabic · Syriac · N'Ko · Adlam** (joining — spacing shatters), RTL non-cursive **Hebrew · Thaana** (bidi matters, spacing doesn't), Indic **Devanagari · Bengali · Gujarati · Tamil · Telugu** (spacing splits conjuncts), SE-Asian **Thai · Lao · Khmer · Myanmar** (no letter-spacing; line-break needs a segmenter), and **CJK** **Han · Hiragana · Katakana · Hangul** (no case; use text-spacing, mind kinsoku).

## What makes it accurate

A typography rule is only a *bug* when Arabic is present, so every check is gated on an Arabic signal:

- **Arabic-script codepoints** (`\p{Script=Arabic}`) in the element's text/subtree or the CSS declaration, **or**
- **`lang="ar"` / `dir="rtl"`** on the element or an ancestor, **or**
- an **`[lang=ar]` / `.ar` / `.arabic` / `:lang(ar)`** selector (CSS).

Detection is parser-verified — **Babel** for JS/TS/JSX/TSX, **PostCSS** for CSS — not brittle regex. That means it reads:

- **`cn()` / `clsx()` / `cva()` / `tv()` / template-literal** class composition, not just `className="…"`
- **inline JSX style objects** — `style={{ fontFamily: 'Inter', letterSpacing, fontSize: 13 }}`
- **arbitrary Tailwind values** — `text-[13px]`, `text-[0.8rem]`, `leading-[1.2]`, `tracking-[0.1em]`

## What it catches (in Arabic context)

- **`letter-spacing` / Tailwind `tracking-*`** → shatters ligatures
- **Tight `line-height`** (`leading-none/tight/snug`, `< 1.5`) → crushes tashkeel
- **Small sizes** (`text-xs/text-sm`, `< 16px`) → Arabic body too small
- **`text-transform: uppercase`** → meaningless on Arabic (no case), hides bugs
- **Latin-only font stacks** → uses an Arabic-font **allowlist** (Cairo, Tajawal, Almarai, Amiri, IBM Plex Sans Arabic, Noto Sans/Kufi Arabic, Rubik, El Messiri, Changa, any family containing "Arabic", …). It flags a stack only when it names a real Latin family **and** has no Arabic family — so `Inter, Cairo` and `"IBM Plex Sans Arabic", Inter` are clean.

## Why it only reports

Typography is judgment — a Latin heading may *want* letter-spacing. kashida flags where Arabic would break and lets you decide; it never edits your code. Its `--init-rules` file teaches your AI agent to stop reintroducing the issues.

## Config & ignores

- **`kashida.config.json`** (project root): `{ "arabicFonts": ["My Arabic Font"], "disable": ["small-size"], "ignore": ["legacy/"] }`
- **`// kashida-ignore`** — suppress this line and the next
- **`// kashida-ignore-file`** — skip the whole file

## In your AI agent (MCP)
```json
{ "mcpServers": { "kashida": { "command": "npx", "args": ["-y","-p","github:moradothmanepro-OTTO/kashida","kashida-mcp"] } } }
```
Tools: `kashida_scan`, `kashida_check_code`.

## GitHub Action
```yaml
- uses: moradothmanepro-OTTO/kashida@v0.3.0
  with:
    path: .
    check: true   # fail the job on any Arabic-typography issue
```

---
Part of **[Otto](https://dev.ottospace.co)** — tools that make the AI-built web work in every language. Built by a native-Arabic Design Engineer. MIT © 2026

## 💛 Support & commercial use

The Miraat suite is free and open-source (MIT). If it helps you ship correct Arabic/RTL, please consider [sponsoring](https://polar.sh/otto-space) — it funds maintenance and new rules.

Using it in a commercial product, in CI, or need the private **DGA compliance** rule pack? **[Miraat Pro](https://polar.sh/otto-space)** adds a commercial license, a hosted CI audit that gates PRs ([miraat-action](https://github.com/Otto-OttoSpace/miraat-action)), and priority support.
