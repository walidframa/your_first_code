import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    proxy,
  },
})
