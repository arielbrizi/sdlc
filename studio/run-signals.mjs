/** Señales puras del stream que el Studio usa para recuperar y cerrar runs. */

export const RECOVERY_PROMPT = `La llamada de herramienta anterior fue interrumpida por el runtime, no por una decisión del usuario. Antes de repetir nada, reconciliá los efectos persistidos: inspeccioná archivos y artefactos del run, git status y commits recientes, el estado del subagente y el PR remoto si correspondía. Si la operación ya produjo su efecto, no la repitas: continuá desde la fase siguiente. Reintentá la herramienta únicamente si confirmás que no se completó. No pidas confirmación para continuar.`;

export function technicalToolInterruption(text) {
  const clean = String(text || '').trim();
  return /^\[?request interrupted by user(?: for tool use)?\]?$/i.test(clean);
}

/** Comandos que crean o inspeccionan el PR final en los trackers soportados. */
export function prCommand(command) {
  const cmd = String(command || '');
  const creates = /\b(?:gh pr create|az repos pr create|glab mr create)\b/.test(cmd);
  const touches = creates || /\b(?:gh pr (?:view|edit)|az repos pr (?:show|update)|glab mr (?:view|update))\b/.test(cmd);
  return { creates, touches };
}

/** Herramientas MCP cuyo nombre evidencia creación, lectura o actualización de PR. */
export function prTool(name) {
  const tool = String(name || '').toLowerCase();
  const creates = /(?:^|__|_)(?:create_pull_request|repo_create_pull_request|pull_request_create)$/.test(tool);
  const touches = creates || /(?:^|__|_)(?:get_pull_request|pull_request_read|repo_get_pull_request_by_id|update_pull_request|repo_update_pull_request)$/.test(tool);
  return { creates, touches };
}

/**
 * Un resumen solo cierra el ciclo si una herramienta confirmó antes el PR.
 * La prosa sirve como segunda señal, no como sustituto de evidencia externa.
 */
export function finalCycleCompletion(text, prConfirmed = false) {
  if (!prConfirmed) return false;
  const clean = String(text || '');
  const saysComplete = /\bciclo\s+completo\b|\blist[oa]\s+para\s+revisi[oó]n\s+humana\b/i.test(clean);
  const deniesCompletion = /\b(?:no|todav[ií]a\s+no|a[uú]n\s+no)\s+(?:est[aá]\s+)?list[oa]\s+para\s+revisi[oó]n\s+humana\b|\bciclo\s+(?:no\s+)?incompleto\b/i.test(clean);
  const hasPr = /\bPR\s*:\s*https?:\/\/\S+|https?:\/\/\S+\/(?:pull|pullrequest|merge_requests)\/\d+/i.test(clean);
  return saysComplete && !deniesCompletion && hasPr;
}
