#!/usr/bin/env node
'use strict';
/*
 * kashida MCP server — lets AI agents (Cursor / Claude / Windsurf) catch
 * Arabic-typography mistakes by calling kashida over the Model Context Protocol.
 * Transport: stdio, newline-delimited JSON-RPC 2.0. (Formerly arabitype.)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'bin', 'kashida.js');
const VERSION = require('../package.json').version;
const PROTOCOL = '2025-06-18';

function runCli(args) {
  try { return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

const TOOLS = [
  {
    name: 'kashida_scan',
    description: 'Scan a file or directory for Arabic-typography mistakes — but only where Arabic is actually present (Arabic glyphs, lang="ar"/dir="rtl", or an .arabic/[lang=ar] selector). Catches letter-spacing/tracking (shatters ligatures), tight line-height (crushes tashkeel), tiny font sizes, uppercase, and Latin-only fonts. Report-only. Returns JSON findings.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File or directory to scan' } }, required: ['path'] }
  },
  {
    name: 'kashida_check_code',
    description: 'Check a CSS/JSX/TSX snippet for Arabic-typography mistakes before you ship Arabic UI. Returns JSON findings (nothing is auto-edited — typography is judgment).',
    inputSchema: { type: 'object', properties: {
      code: { type: 'string', description: 'The code snippet' },
      ext: { type: 'string', description: 'File extension for context, e.g. .tsx or .css (default .tsx)' }
    }, required: ['code'] }
  }
];

function callTool(name, args) {
  if (name === 'kashida_scan') return runCli([args.path, '--json']);
  if (name === 'kashida_check_code') {
    const ext = args.ext && args.ext.startsWith('.') ? args.ext : '.tsx';
    const tmp = path.join(os.tmpdir(), `kashida-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`);
    fs.writeFileSync(tmp, args.code);
    const out = runCli([tmp, '--json']);
    try { fs.unlinkSync(tmp); } catch {}
    return out;
  }
  throw new Error('unknown tool: ' + name);
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'kashida', version: VERSION } } });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: callTool(params.name, params.arguments || {}) }] } }); }
    catch (e) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true } }); }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stderr.write(`kashida MCP server v${VERSION} ready\n`);
