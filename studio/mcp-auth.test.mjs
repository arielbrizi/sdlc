import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpStatus, pluginMcpName } from './mcp-auth.mjs';

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
