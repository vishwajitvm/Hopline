#!/usr/bin/env node
import { run } from '../src/cli.js';
import { colors } from '../src/utils/terminal.js';

run(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`\n${colors.red('✖')} ${err.message}\n`);
  if (process.env.HOPLINE_DEBUG) process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
});
