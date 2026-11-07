---
name: hopline-dev
description: Run Hopline locally for development — dev server with hot reload, single-process production mode, desktop app, or CLI. Use when asked to run, start, try or preview the app without Docker.
---

# Run Hopline locally

1. Make sure dependencies are installed: `npm install` (Node ≥ 20.12; `.nvmrc` says 22).
2. Pick the mode:

| Goal                          | Command                                                               | URL                                     |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| Develop with hot reload       | `npm run dev`                                                         | http://localhost:5290 (server on :8787) |
| Production-style, one process | `npm run build` then `npm start`                                      | http://localhost:8787                   |
| Desktop app                   | `npm run desktop` (or `npm run desktop:dev` while `npm run dev` runs) | native window                           |
| CLI                           | `npm run cli -- send <paths>` / `npm run cli -- receive <code>`       | terminal                                |

3. Run long-lived servers in the background and wait for `Hopline server started` / Vite's `ready` line before
   opening the browser.

## Notes

- Port 5290 is fixed (`strictPort`). If it's busy, set `WEB_DEV_PORT` in `.env` and update the `desktop:dev`
  script URL. Don't use 5173/5180: other projects' containers occupy them on this machine.
- Settings come from the root `.env` (git-ignored). Shell variables override it.
- Debug hooks: in the browser run `localStorage.setItem('hopline:debug','1')`, reload, then
  `window.__hopline.dropConnection()` / `dropServer()` simulate network failures.
- Don't edit source files while testing in an open tab: Vite hot-reload wipes the session.
- Stop servers you started when done (by task id, never by broad process-kill patterns).
