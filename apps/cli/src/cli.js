import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { receiveFiles } from './commands/receive.js';
import { sendFiles } from './commands/send.js';
import { colors } from './utils/terminal.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `
${colors.bold('hopline')} — send files directly between computers, end-to-end encrypted.

${colors.bold('Usage')}
  hopline send <file|folder>... [--port <n>]
  hopline receive <code> [--out <dir>] [--host <ip:port>] [--yes]

${colors.bold('Commands')}
  send       Share files or folders. Prints a code for the other computer.
  receive    Receive files using the code from the sender.

${colors.bold('Options')}
  -o, --out <dir>      Where to save received files (default: a new "Hopline <date>" folder)
      --host <ip:port> Connect to the sender directly instead of searching the network
      --port <n>       Port the sender listens on (default: random)
  -y, --yes            Accept incoming files without asking
  -h, --help           Show this help
  -v, --version        Show the version

${colors.bold('Examples')}
  hopline send ./photos report.pdf
  hopline receive 42-amber-river-falcon --out ~/Downloads
`;

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  host: { type: 'string' },
  port: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

function parsePort(value) {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

const COMMANDS = {
  async send(args, flags) {
    if (args.length === 0) throw new Error('Tell Hopline what to send, e.g. "hopline send ./photos"');
    await sendFiles(args, { port: parsePort(flags.port) });
  },
  async receive(args, flags) {
    if (args.length !== 1)
      throw new Error('Pass the transfer code, e.g. "hopline receive 42-amber-river-falcon"');
    await receiveFiles(args[0], { outDir: flags.out, host: flags.host, autoAccept: flags.yes });
  },
};
COMMANDS.recv = COMMANDS.receive;

export async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new Error(`${err.message}\nRun "hopline --help" for usage.`);
  }
  const { values: flags, positionals } = parsed;
  const [command, ...args] = positionals;

  if (flags.version) {
    console.log(version);
    return;
  }
  if (flags.help || !command || command === 'help') {
    console.log(HELP);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) throw new Error(`Unknown command "${command}". Run "hopline --help" for usage.`);
  await handler(args, flags);
}
