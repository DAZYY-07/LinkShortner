import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://127.0.0.1:8088',
      '/shorten': 'http://127.0.0.1:8088',
      '/stats': 'http://127.0.0.1:8088',
      '/my-links': 'http://127.0.0.1:8088',
      '/resolve': 'http://127.0.0.1:8088',
    },
  },
})

