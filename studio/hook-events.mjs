/**
 * Devuelve solamente las líneas completas y nuevas del log de hooks.
 *
 * El archivo puede pertenecer a una ejecución anterior de la misma historia:
 * `startedAt` evita recontarlas. `cursor` evita volver a emitir las que ya leyó
 * este servidor. Una última línea incompleta queda pendiente para el próximo
 * poll en vez de transformarse en un evento corrupto.
 */
export function hookEventsSince(content, cursor = 0, startedAt = 0, runId = '') {
  const text = String(content || '');
  const lastBreak = text.lastIndexOf('\n');
  if (lastBreak < 0) return { cursor: 0, events: [] };

  const lines = text.slice(0, lastBreak).split('\n');
  const from = cursor > lines.length ? 0 : Math.max(0, cursor);
  const events = [];

  for (const line of lines.slice(from)) {
    if (!line.trim()) continue;
    let data;
    try { data = JSON.parse(line); } catch { continue; }
    const at = Date.parse(data.at);
    if (!Number.isFinite(at) || at < startedAt - 1000) continue;
    if (runId && data.run !== runId) continue;
    if (!/^[A-Za-z]+$/.test(data.event || '')) continue;
    if (!/^[A-Za-z0-9._-]+\.sh$/.test(data.script || '')) continue;
    events.push({ event: data.event, script: data.script, at });
  }

  return { cursor: lines.length, events };
}
