#!/usr/bin/env node

// Bloquea rutas típicas de secretos recibidas en el payload de PreToolUse.
// Exit 2 = bloquear la tool call.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString()).tool_input ?? {};
} catch {
  process.exit(0);
}

const fields = [
  input.file_path,
  input.path,
  input.notebook_path,
  input.command,
].filter(Boolean).map(String);

const blockedPatterns = [
  /(^|[^A-Za-z0-9_.-])\.env($|[^A-Za-z0-9_.-])/i,
  /(^|[^A-Za-z0-9_.-])\.env\.(local|dev|development|test|staging|prod|production)($|[^A-Za-z0-9_.-])/i,
  /(^|[^A-Za-z0-9_.-])credentials?(\.(ya?ml|json|toml|ini|conf))?($|[^A-Za-z0-9_.-])/i,
  /(^|[^A-Za-z0-9_.-])secrets?\.(ya?ml|json|toml)($|[^A-Za-z0-9_.-])/i,
  /(^|[^A-Za-z0-9_.-])id_rsa($|[^A-Za-z0-9_.-])/i,
  /\.pem($|[^A-Za-z0-9_.-])/i,
  /\.p12($|[^A-Za-z0-9_.-])/i,
  /\.keystore($|[^A-Za-z0-9_.-])/i,
  /terraform\.tfstate($|[^A-Za-z0-9_.-])/i,
];

for (const field of fields) {
  if (!blockedPatterns.some((pattern) => pattern.test(field))) continue;
  console.error(`BLOQUEADO por política del plugin: ${field} puede contener secretos.`);
  console.error('Si necesitas una variable de entorno, referenciala por nombre sin leer el archivo.');
  process.exit(2);
}
