# kashida

**Catch the Arabic-typography mistakes that quietly break Arabic rendering — but only where Arabic is actually in play.**

> Formerly published as `arabitype`. Same tool, hardened: it now proves Arabic is present before it flags anything, so a pure-Latin file reports **zero** issues.

Arabic (`كَشِيدَة` — the elongation stroke that connects its letters) is a connected, cursive script that carries diacritics (tashkeel). The Latin-default styling AI codegen produces *breaks* it: `letter-spacing` shatters the ligatures, tight `line-height` crushes the tashkeel, small sizes hurt legibility, `uppercase` is meaningless, and Latin-only fonts render Arabic in an ugly fallback. **kashida** flags all five — and *only* when the styled element actually involves Arabic.

```bash
npx kashida .              # report Arabic-typography issues
npx kashida . --json       # machine-readable (CI)
npx kashida . --check      # report only, exit non-zero if anything found (CI)
npx kashida . --init-rules # write ARABIC-TYPE-RULES.md for your AI agent
```

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
- uses: moradothmanepro-OTTO/kashida@v0.2.0
  with:
    path: .
    check: true   # fail the job on any Arabic-typography issue
```

---
Part of **[Otto](https://dev.ottospace.co)** — tools that make the AI-built web work in every language. Built by a native-Arabic Design Engineer. MIT © 2026
