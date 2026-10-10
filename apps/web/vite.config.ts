/**
 * The UI: a static page built into `dist/ui` (the tomls' `[assets] directory`). In development
 * Vite serves it on DEV_UI_PORT and proxies `/api` and `/auth` to `wrangler dev` on DEV_API_PORT,
 * so the browser sees one origin (APP_URL). `scripts/dev.mjs` sets the ports; Launch sets
 * DEV_ALLOWED_HOSTS to its preview host suffix (launch.kit.json → session.ports).
 */
import { defineConfig } from 'vite'

const uiPort = Number(process.env.DEV_UI_PORT || 3000)
const apiPort = Number(process.env.DEV_API_PORT || 3001)
const allowedHosts = (process.env.DEV_ALLOWED_HOSTS ?? '')
  .split(',')
  .map(h => h.trim())
  .filter(Boolean)
const api = `http://127.0.0.1:${apiPort}`

export default defineConfig({
  root: 'src/ui',
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  server: {
    host: '0.0.0.0',
    port: uiPort,
    strictPort: true,
    allowedHosts: allowedHosts.length ? allowedHosts : undefined,
    proxy: { '/api': api, '/auth': api },
  },
})
