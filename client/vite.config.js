import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Stamp the service worker with the build it belongs to.
 *
 * `public/sw.js` is copied verbatim, which is what a service worker needs — it
 * must live at the root to control the whole app, so it cannot carry a hash in
 * its filename the way every other asset does. That left it byte-identical
 * from one deploy to the next, so browsers saw no reason to install a new one
 * and tills kept serving the cache the old one had built. A shop ran four
 * deploys behind and the only cure was clearing the site by hand.
 *
 * The stamp is a hash of the filenames this build emitted, so it moves exactly
 * when the app moves and not on every rebuild of identical code — a byte
 * different in sw.js is what makes the browser fetch it, and a byte different
 * for no reason is an update prompt for no reason.
 */
function stampServiceWorker() {
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    // After everything, including the copy of `public/`, is on disk.
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        const dist = path.resolve(import.meta.dirname, 'dist')
        const file = path.join(dist, 'sw.js')
        let source
        try {
          source = readFileSync(file, 'utf8')
        } catch {
          return // No worker in this build; nothing to stamp.
        }
        const assets = readFileSync(path.join(dist, 'index.html'), 'utf8')
        const build = createHash('sha256').update(assets).digest('hex').slice(0, 12)
        writeFileSync(file, source.replaceAll('__BUILD__', build))
      },
    },
  }
}

// Overridable so the e2e runner can point the client at a throwaway API.
const apiTarget = process.env.API_TARGET || 'http://localhost:4000'
const proxy = {
  '/api': {
    target: apiTarget,
    changeOrigin: true,
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    proxy,
  },
})
