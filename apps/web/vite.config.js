import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** One .env at the repository root configures every app (server, web, desktop, Docker). */
const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '');
  // Where the dev server forwards /ws and /health. 127.0.0.1 (not "localhost") avoids IPv6 surprises on Windows.
  const signalingTarget = env.SIGNALING_PROXY_TARGET || 'http://127.0.0.1:8787';

  return {
    // Relative asset paths so the same build works on any host, behind a sub-path, and inside Electron (file://).
    base: './',
    envDir,
    plugins: [react()],
    server: {
      host: true,
      // A fixed, uncommon port so it doesn't collide with other Vite projects and the desktop dev URL never changes.
      port: Number(env.WEB_DEV_PORT) || 5290,
      strictPort: true,
      proxy: {
        '/ws': { target: signalingTarget, ws: true },
        '/health': signalingTarget,
      },
    },
    preview: { port: 4173 },
    build: {
      target: 'es2022',
      sourcemap: mode !== 'production',
    },
  };
});
