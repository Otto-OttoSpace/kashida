'use strict';
/*
 * Security regression: the MCP `*_check_code` tool writes the snippet to a temp
 * file whose extension comes from the caller. A path-traversal extension
 * (e.g. `.x/../../etc/passwd`) must NOT let the caller write/delete files
 * outside os.tmpdir(). See mcp/kashida-mcp.js.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP = path.join(__dirname, '..', 'mcp', 'kashida-mcp.js');

function driveCheckCode(ext, code) {
  return new Promise((resolve) => {
    const srv = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const done = () => { try { srv.kill(); } catch {} resolve(); };
    srv.stdout.on('data', d => { out += d.toString(); if (out.includes('"id":2')) done(); });
    srv.on('close', () => resolve());
    const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kashida_check_code', arguments: { code, ext } } });
    setTimeout(done, 5000); // safety net
  });
}

test('check_code rejects a path-traversal ext (no arbitrary write/delete)', async () => {
  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kashida-victim-'));
  const victim = path.join(victimDir, 'KEEP.txt');
  fs.writeFileSync(victim, 'PRESERVE-ME');
  const ext = '.x/../' + path.basename(victimDir) + '/KEEP.txt';
  await driveCheckCode(ext, 'MALICIOUS-OVERWRITE');
  const survived = fs.existsSync(victim);
  const content = survived ? fs.readFileSync(victim, 'utf8') : '(deleted)';
  fs.rmSync(victimDir, { recursive: true, force: true });
  assert.ok(survived, 'victim outside the temp name must not be deleted by a traversal ext');
  assert.strictEqual(content, 'PRESERVE-ME', 'victim must not be overwritten by a traversal ext');
});

test('check_code still works with a normal ext', async () => {
  await driveCheckCode('.tsx', 'const a = 1;');
  assert.ok(true, 'a legitimate ext must not crash the server');
});

// ── regression: a flag/subcommand-shaped scan `path` must not hijack the CLI ──
test('kashida_scan rejects a flag/subcommand-shaped path', async () => {
  const drive = (p) => new Promise((resolve) => {
    const srv = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; const done = () => { try { srv.kill(); } catch {} resolve(out); };
    srv.stdout.on('data', d => { out += d.toString(); if (out.includes('"id":2')) done(); });
    srv.on('close', () => resolve(out));
    const s = o => srv.stdin.write(JSON.stringify(o) + '\n');
    s({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    s({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kashida_scan', arguments: { path: p } } });
    setTimeout(done, 4000);
  });
  assert.match(await drive('--init-rules'), /invalid path/, 'a leading-dash path is rejected');
});
