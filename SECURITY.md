# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do **not** open a public issue.
- Preferred: GitHub → the repo's **Security** tab → **Report a vulnerability** (private advisory).
- Or email **work@ottospace.co**.

You'll get an acknowledgement as fast as possible, and coordinated disclosure once a fix is ready.

## What Kashida does with your code

Kashida is a static analyzer that runs entirely on your machine.

- **Offline / telemetry-free.** The default (static) analysis makes **no network calls** — nothing about your code, findings, or usage is ever sent anywhere. No analytics, no phone-home, no accounts.
- **Read-scoped & report-only.** It only reads the files/paths you point it at, and it **never edits your source**.
- **No secrets handling.** It parses source for Arabic typography / shaping patterns; it does not read `.env` files, credentials, or network resources.
- **`--url` (opt-in) is the one exception:** if you pass a URL, Kashida launches a headless browser (Playwright) to render **only the address you supply**. The default file-based analysis never touches the network.

## Supply chain

- Runtime dependencies are minimal and pinned (see `package.json`); shaping/rendering deps are **optional** and degrade gracefully when absent. A small `files` allowlist means only source + docs are published.
- Prefer a **pinned tag** — `npx github:Otto-OttoSpace/kashida@<tag>` — over a moving branch for reproducible, auditable runs.
- MIT/OFL-licensed; the full source is public and auditable.

## Supported versions

The latest published version receives fixes. Older 0.x versions are not maintained.
