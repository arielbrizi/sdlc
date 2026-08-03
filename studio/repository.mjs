import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const normalizeRepoName = value => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\.git$/i, '')
  .replace(/[^a-z0-9]+/g, '');

export function repoNames(repoRoot, remoteUrl = '', scope = '') {
  const names = new Set([path.basename(repoRoot), scope && path.basename(scope)]);
  const cleanRemote = String(remoteUrl).replace(/\.git$/i, '').replace(/\/+$/, '');
  if (cleanRemote) names.add(cleanRemote.split(/[/:]/).filter(Boolean).at(-1));
  return [...names].filter(Boolean);
}

export function repoHintVerdict(hint, names) {
  const hints = (Array.isArray(hint) ? hint : String(hint || '').split(','))
    .map(v => String(v).trim()).filter(Boolean);
  if (!hints.length) return { status: 'none', hints: [], matches: [] };
  if (hints.length > 1) return { status: 'multi-repo', hints, matches: [] };
  const expected = normalizeRepoName(hints[0]);
  const matches = names.filter(name => {
    const actual = normalizeRepoName(name);
    return actual === expected || actual.includes(expected) || expected.includes(actual);
  });
  return { status: matches.length ? 'match' : 'mismatch', hints, matches };
}

export async function discoverWorkspaces(repoRoot, maxDepth = 3) {
  const markers = new Set([
    'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
    'settings.gradle.kts', 'pyproject.toml', 'go.mod', 'Cargo.toml', '*.csproj',
  ]);
  const ignored = new Set(['.git', '.claude', 'node_modules', 'vendor', 'dist', 'build', '.next', 'target']);
  const found = new Set(['.']);

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    if (dir !== repoRoot && files.some(name => markers.has(name) || name.endsWith('.csproj'))) {
      found.add(path.relative(repoRoot, dir).split(path.sep).join('/'));
    }
    await Promise.all(entries
      .filter(e => e.isDirectory() && !ignored.has(e.name) && !e.name.startsWith('.'))
      .map(e => walk(path.join(dir, e.name), depth + 1)));
  }

  await walk(repoRoot, 0);
  return [...found].sort((a, b) => a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b));
}

export async function discoverProjectProfile(scopeDir) {
  const exists = name => fs.existsSync(path.join(scopeDir, name));
  const profile = { technologies: [], commands: {}, rules: [], ci: false };
  if (exists('CLAUDE.md')) profile.rules.push('CLAUDE.md');
  if (exists('.claude/rules')) profile.rules.push('.claude/rules/');
  profile.ci = ['.github/workflows', '.gitlab-ci.yml', 'azure-pipelines.yml'].some(exists);

  if (exists('package.json')) {
    profile.technologies.push('Node.js');
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(scopeDir, 'package.json'), 'utf8'));
      for (const name of ['test', 'lint', 'build']) {
        if (pkg.scripts?.[name]) profile.commands[name] = `npm run ${name}`;
      }
    } catch { /* package inválido: lo detectará la suite del proyecto */ }
  }
  if (exists('pyproject.toml')) { profile.technologies.push('Python'); profile.commands.test ||= 'pytest'; }
  if (exists('pom.xml')) { profile.technologies.push('Java/Maven'); profile.commands.test ||= 'mvn test'; profile.commands.build ||= 'mvn package'; }
  if (exists('build.gradle') || exists('build.gradle.kts')) { profile.technologies.push('Java/Gradle'); profile.commands.test ||= './gradlew test'; profile.commands.build ||= './gradlew build'; }
  if (exists('go.mod')) { profile.technologies.push('Go'); profile.commands.test ||= 'go test ./...'; profile.commands.build ||= 'go build ./...'; }
  if (exists('Cargo.toml')) { profile.technologies.push('Rust'); profile.commands.test ||= 'cargo test'; profile.commands.build ||= 'cargo build'; }
  if ((await fsp.readdir(scopeDir).catch(() => [])).some(name => name.endsWith('.csproj') || name.endsWith('.sln'))) {
    profile.technologies.push('.NET'); profile.commands.test ||= 'dotnet test'; profile.commands.build ||= 'dotnet build';
  }
  profile.ready = profile.technologies.length > 0;
  return profile;
}

export function isolatedWorktreePath(workspace, repoRoot, storyId, scope = '.') {
  const digest = createHash('sha256').update(`${path.resolve(repoRoot)}\0${scope}`).digest('hex').slice(0, 10);
  const repo = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '-');
  const story = String(storyId).replace(/[^A-Za-z0-9._-]/g, '-');
  return path.join(workspace, '.flow360-worktrees', `${repo}-${digest}`, story);
}

export function safeScope(repoRoot, scope = '.') {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, String(scope || '.'));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Object.assign(new Error('el alcance sale del repositorio'), { code: 400 });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw Object.assign(new Error(`el alcance no existe: ${scope}`), { code: 400 });
  }
  return resolved;
}
