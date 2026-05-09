import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Allow `vite preview` to serve the build behind any hostname.
  // Without this, deploying to Railway / Render / Fly.io is blocked by
  // Vite's host-check security feature.
  preview: {
    allowedHosts: true,
  },
})
