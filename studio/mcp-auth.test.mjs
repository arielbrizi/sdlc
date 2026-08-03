import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpLoginCommand, parseMcpStatus, pluginMcpName } from './mcp-auth.mjs';

test('reconoce conexión y nombre calificado de un MCP del plugin', () => {
  assert.equal(pluginMcpName('globant-sdlc', 'figma'), 'plugin:globant-sdlc:figma');
  assert.equal(parseMcpStatus('Status: ✓ Connected').status, 'connected');
});

test('diferencia OAuth pendiente de una falla de red', () => {
  assert.equal(parseMcpStatus('Status: ✘ Failed to connect\nIssue: Authentication required').status,
    'auth_required');
  assert.equal(parseMcpStatus('Status: ✘ Failed to connect\nIssue: ENOTFOUND mcp.figma.com').status,
    'unavailable');
});

test('el login MCP hereda la terminal cuando Studio tiene una disponible', () => {
  const args = ['mcp', 'login', 'figma'];
  assert.deepEqual(mcpLoginCommand(args, { platform: 'darwin', stdinIsTTY: true }), {
    command: 'claude',
    args,
    stdin: 'inherit',
  });
});

test('el login MCP recibe una pseudo-terminal en macOS si Studio no heredó una', () => {
  const args = ['mcp', 'login', 'figma'];
  assert.deepEqual(mcpLoginCommand(args, { platform: 'darwin', stdinIsTTY: false }), {
    command: '/usr/bin/script',
    args: ['-q', '/dev/null', 'claude', ...args],
    stdin: 'ignore',
  });
});
