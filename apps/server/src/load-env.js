import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The repository's .env (absent inside Docker images, where settings come from the container environment). */
const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/**
 * Loads KEY=value pairs from the .env file into process.env, using Node's built-in parser.
 * Variables that are already set (shell, Docker, Render…) always win over the file.
 * Override the location with HOPLINE_ENV_FILE.
 * @returns {string | null} the file that was loaded
 */
export function loadEnvFile(path = process.env.HOPLINE_ENV_FILE || ROOT_ENV_FILE) {
  if (typeof process.loadEnvFile !== 'function' || !existsSync(path)) return null;
  process.loadEnvFile(path);
  return path;
}
