import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The agent runtime's HTTP bridge (web-server plugin) listens on 8787.
// In dev we proxy /api to it so the browser can call it without CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
