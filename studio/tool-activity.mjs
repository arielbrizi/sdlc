const clean = value => String(value || '').trim();

const compactPath = value => {
  const path = clean(value);
  if (!path) return 'un archivo del proyecto';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
};

/** Traduce herramientas de Claude Code a estados útiles para quien mira el run. */
export function toolActivity(name, input = {}) {
  if (name === 'ToolSearch') {
    const query = clean(input.query);
    const git = /(?:^|\s)git(?:\s|$)/i.test(query);
    const shell = /bash|shell|command/i.test(query);
    const target = git && shell
      ? 'para ejecutar comandos del repositorio y trabajar con Git'
      : query ? `compatible con “${query.replace(/^\+/, '')}”` : 'compatible con la tarea';
    return {
      summary: `Buscando una herramienta ${target}`,
      progress: `Buscando una herramienta ${target}`,
      success: 'Búsqueda completada; Claude Code recibió una respuesta y puede continuar',
    };
  }

  if (name === 'Bash') return {
    summary: clean(input.command),
    progress: 'Ejecutando un comando en el repositorio',
    success: 'Comando completado',
  };

  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const file = compactPath(input.file_path || input.notebook_path);
    const action = name === 'Read' ? 'Leyendo' : name === 'Write' ? 'Creando' : 'Actualizando';
    return {
      summary: `${action} ${file}`,
      progress: `${action} ${file}`,
      success: `${file} procesado correctamente`,
    };
  }

  if (['Glob', 'Grep'].includes(name)) {
    const pattern = clean(input.pattern);
    return {
      summary: pattern ? `Buscando “${pattern}” en el proyecto` : 'Buscando en el proyecto',
      progress: 'Buscando información en el proyecto',
      success: 'Búsqueda en el proyecto completada',
    };
  }

  return {
    summary: '',
    progress: `Usando ${name}`,
    success: `${name} respondió correctamente`,
  };
}
