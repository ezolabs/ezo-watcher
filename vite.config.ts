import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/web', emptyOutDir: true, target: 'es2023' },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8799', '/ingest': 'http://127.0.0.1:8799', '/healthz': 'http://127.0.0.1:8799' } }
})
