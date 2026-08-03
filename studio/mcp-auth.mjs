const clean = value => String(value || '').replace(/\x1b\[[0-9;]*m/g, '').trim();

/** Convierte la salida humana de `claude mcp get` en un estado estable para la UI. */
export function parseMcpStatus(stdout, stderr = '', code = 0) {
  const text = clean([stdout, stderr].filter(Boolean).join('\n'));
  const issue = text.match(/^\s*Issue:\s*(.+)$/im)?.[1]?.trim() || '';

  if (/Status:\s*(?:✓|✔)?\s*Connected\b/i.test(text)) {
    return { status: 'connected', detail: 'Conectado y listo para usar.' };
  }
  if (/Pending approval/i.test(text)) {
    return { status: 'approval_required', detail: 'Falta aprobar este MCP para el proyecto.' };
  }
  if (/(?:authentication required|needs authentication|not authenticated|unauthorized|oauth|\b401\b|\b403\b)/i.test(issue || text)) {
    return { status: 'auth_required', detail: issue || 'Necesita iniciar sesión.' };
  }
  if (/No MCP server named/i.test(text)) {
    return { status: 'not_configured', detail: 'El MCP no está disponible en este plugin.' };
  }
  if (code !== 0 || /Failed to connect/i.test(text)) {
    return { status: 'unavailable', detail: issue || text.slice(-400) || 'No se pudo comprobar la conexión.' };
  }
  return { status: 'unknown', detail: issue || text.slice(-400) || 'Claude Code no informó el estado.' };
}

export const pluginMcpName = (pluginName, server) =>
  pluginName ? `plugin:${pluginName}:${server}` : server;

/**
 * `claude mcp login` necesita una terminal interactiva aunque el OAuth se
 * complete en el navegador. Si Studio no heredó una, macOS puede darle una
 * pseudo-terminal con `script` sin exponer el callback ni las credenciales.
 */
export function mcpLoginCommand(args, { platform, stdinIsTTY }) {
  if (stdinIsTTY) {
    return { command: 'claude', args, stdin: 'inherit' };
  }
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/script',
      args: ['-q', '/dev/null', 'claude', ...args],
      stdin: 'ignore',
    };
  }
  return { command: 'claude', args, stdin: 'ignore' };
}
