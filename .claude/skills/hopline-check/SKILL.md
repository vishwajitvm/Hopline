---
name: hopline-check
description: Run Hopline's full quality gate (lint, format, all tests, production build) and fix what fails. Use before committing, after any code change, or when asked to verify, check or test the project.
---

# Quality gate

Run, in order, and fix failures before moving on:

```bash
npx prettier --write .        # format (writes)
npx eslint .                  # 0 errors expected
npm test                      # 55 tests across server, protocol, transfer engine, CLI
npm run build                 # web production build
```

`npm run check` runs lint + format check + tests + build in one go.

## When something fails

- **A test times out**: first ask whether the machine is overloaded (`docker stats --no-stream`: other projects'
  containers can use 600%+ CPU). Re-run that file alone with
  `node --test --test-timeout=120000 --test-concurrency=1 <file>`. A pass on a quiet run means the test needs
  more tolerance (use `waitFor`, longer grace periods), not that the app is broken. Prove which it is.
- **Proving a regression test works**: temporarily revert the fix, confirm the test fails, restore. Don't do this
  while a Vite dev tab is mid-test.
- **ESLint `no-irregular-whitespace`**: literal invisible characters slipped into source. Rebuild the regex from
  numeric code points (see `DECEPTIVE_RANGES` in `apps/web/src/utils/paths.js`).
- **Node `--test` with globs**: pass quoted globs (`"apps/*/test/**/*.test.js"`), not directories.
- Run long suites in the background with output redirected to a file; piping into `Select-String` buffers
  everything until the end.

Report results honestly: say which tests ran, how many passed, and anything skipped.
