const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };

function formatPretty(level, msg, fields) {
  const time = new Date().toISOString().slice(11, 23);
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? `  ${extra}` : ''}\n`;
}

function formatJson(level, msg, fields) {
  return `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`;
}

/**
 * Minimal structured logger: human-readable in development, JSON lines in production
 * (so Docker / log collectors can parse it). No dependencies.
 */
export function createLogger({ level = 'info', format = 'pretty', bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const formatter = format === 'json' ? formatJson : formatPretty;

  const log = (lvl) => (msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const out = LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout;
    const merged = { ...bindings, ...fields };
    if (merged.err instanceof Error) merged.err = { message: merged.err.message, stack: merged.err.stack };
    out.write(formatter(lvl, msg, merged));
  };

  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (extra) => createLogger({ level, format, bindings: { ...bindings, ...extra } }),
  };
}

export const silentLogger = createLogger({ level: 'silent' });
