// The hosted demo's build (npm run build:demo -> dist/demo, deployed on Cloudflare Pages): the same index.html and app as the real wall, with
// src/web/demo/main.tsx as the entry so /api is answered in the browser from a recording (src/web/demo/watcher.ts). The production build
// (vite.config.ts) is untouched. Pages reads _redirects and _headers from the output: every path serves the app, under the wall's own
// Content-Security-Policy (src/server/app.ts), so the demo runs under the same rules as a real Watcher.

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ')

function demoPage(): Plugin {
  return {
    name: 'ezo-demo-page',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const entry = '<script type="module" src="/src/web/main.tsx"></script>'
        if (!html.includes(entry)) throw new Error('index.html no longer loads /src/web/main.tsx: point vite.demo.config.ts at its entry')
        return html
          .replace(entry, '<script type="module" src="/src/web/demo/main.tsx"></script>')
          .replace('<title>EZO Watcher</title>', '<title>EZO Watcher demo</title>')
          .replace(
            /<meta name="description" content="[^"]*" \/>/,
            '<meta name="description" content="Try the EZO Watcher alert wall with sample data: acknowledge, silence and re-check, all in your browser." />'
          )
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_redirects', source: '/* /index.html 200\n' })
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          `  Content-Security-Policy: ${CSP}`,
          '  X-Content-Type-Options: nosniff',
          '  Referrer-Policy: no-referrer',
          '/assets/*',
          '  Cache-Control: public, max-age=31536000, immutable',
          ''
        ].join('\n')
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), demoPage()],
  build: { outDir: 'dist/demo', emptyOutDir: true, target: 'es2023' },
  preview: { port: 4174 }
})
