import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Backend the dev server proxies API calls to; override with BACKEND_PROXY_TARGET.
// xfwd sends X-Forwarded-Host so the backend can build short links that point at this dev server.
const backend = { target: process.env.BACKEND_PROXY_TARGET || 'http://127.0.0.1:8088', xfwd: true }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': backend,
      '/shorten': backend,
      '/stats': backend,
      '/my-links': backend,
      '/resolve': backend,
      '/guest-quota': backend,
    },
  },
})

