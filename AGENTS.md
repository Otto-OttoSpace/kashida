# AGENTS.md — Arabic typography rules for AI agents (kashida)

When styling anything that can hold Arabic text:
1. **Never** apply `letter-spacing` / Tailwind `tracking-*` to Arabic — it shatters the cursive joins & ligatures. Keep it `0`/`normal`.
2. Give Arabic room: `line-height` ≥ 1.5 (never `leading-none/tight/snug`) so tashkeel (diacritics) don't collide.
3. Arabic body text ≥ 16px (avoid `text-xs`/`text-sm` for body).
4. Never `text-transform: uppercase` on Arabic — it has no case; it does nothing and hides bugs.
5. Use an Arabic-capable font with a real fallback (e.g. `"Cairo","IBM Plex Sans Arabic", system-ui`) — never a Latin-only stack for Arabic.

Run `npx kashida .` before finishing — it must report zero Arabic-type issues. (kashida only flags where Arabic is actually present, so pure-Latin styling is left alone. Formerly `arabitype`.)
