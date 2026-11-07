import { createInterface } from 'node:readline/promises';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const colors = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
};

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[exponent]}`;
}

export function formatDuration(seconds) {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

const RENDER_INTERVAL_MS = 100;
const BAR_WIDTH = 24;

/** Single-line progress bar with throughput. Falls back to silence when stdout isn't a terminal. */
class ProgressBar {
  #total;
  #label;
  #bytes = 0;
  #startedAt = Date.now();
  #lastRender = 0;
  #interactive = Boolean(process.stdout.isTTY);

  constructor(total, label) {
    this.#total = total;
    this.#label = label;
  }

  advance(bytes) {
    this.#bytes += bytes;
    const now = Date.now();
    if (now - this.#lastRender >= RENDER_INTERVAL_MS) {
      this.#lastRender = now;
      this.#render();
    }
  }

  /** Draws the final state and returns the elapsed seconds. */
  finish() {
    this.#render();
    if (this.#interactive) process.stdout.write('\n');
    return (Date.now() - this.#startedAt) / 1000;
  }

  #render() {
    if (!this.#interactive) return;
    const ratio = this.#total > 0 ? Math.min(1, this.#bytes / this.#total) : 1;
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const seconds = (Date.now() - this.#startedAt) / 1000;
    const speed = seconds > 0 ? this.#bytes / seconds : 0;
    const line =
      `${this.#label} ${colors.cyan(bar)} ${String(Math.floor(ratio * 100)).padStart(3)}%  ` +
      `${formatBytes(this.#bytes)} / ${formatBytes(this.#total)}  ${formatBytes(speed)}/s`;
    process.stdout.write(`\r${line}\x1b[K`);
  }
}

const NOOP_PROGRESS = { advance() {}, finish: () => 0 };

/**
 * Everything the commands print goes through a reporter, so `quiet: true` (tests, scripting)
 * silences output without sprinkling conditionals through the transfer logic.
 */
export function createReporter({ quiet = false } = {}) {
  if (quiet) {
    const noop = () => {};
    return { info: noop, warn: noop, success: noop, progress: () => NOOP_PROGRESS };
  }
  return {
    info: (message = '') => console.log(message),
    warn: (message) => console.error(colors.yellow(`! ${message}`)),
    success: (message) => console.log(colors.green(`✔ ${message}`)),
    progress: (total, label) => new ProgressBar(total, label),
  };
}

/** Yes/no prompt; Enter means yes. Returns false when there's no terminal to ask. */
export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${colors.dim('[Y/n]')} `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
