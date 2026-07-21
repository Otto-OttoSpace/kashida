# arabitype

**Catch the Arabic-typography mistakes that quietly break Arabic rendering.**

Arabic is a connected, cursive script that carries diacritics (tashkeel). So the Latin-default styling AI codegen produces *breaks* it: `letter-spacing` shatters the ligatures, tight `line-height` crushes the tashkeel, small sizes hurt legibility, `uppercase` is meaningless, and Latin-only fonts render Arabic in an ugly fallback. `arabitype` flags all five.

```bash
npx arabitype .              # report Arabic-typography issues
npx arabitype . --json       # machine-readable (CI)
npx arabitype . --init-rules # write ARABIC-TYPE-RULES.md for your AI agent
```

## What it catches
- **`letter-spacing` / Tailwind `tracking-*`** on Arabic → shatters ligatures
- **Tight `line-height`** (`leading-none/tight/snug`, `< 1.5`) → crushes tashkeel
- **Small sizes** (`text-xs/text-sm`, `< 16px`) → Arabic body too small
- **`text-transform: uppercase`** → meaningless on Arabic (no case), hides bugs
- **Latin-only font stacks** → add an Arabic family fallback

## Why it only reports
Typography is judgment — a Latin heading may *want* letter-spacing. arabitype flags where Arabic would break and lets you decide, and its `--init-rules` file teaches your AI agent to stop.

## In your AI agent (MCP)
```json
{ "mcpServers": { "arabitype": { "command": "npx", "args": ["-y","-p","github:moradothmanepro-OTTO/arabitype","arabitype-mcp"] } } }
```
Tools: `arabitype_scan`, `arabitype_check_code`.

---
Part of **[Otto](https://dev.ottospace.co)** — tools that make the AI-built web work in every language. Built by a native-Arabic Design Engineer. MIT © 2026
