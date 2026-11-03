import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

export default defineConfig(() => {
  const https = process.env.PIANOVAL_HTTPS === '1'
    ? { cert: readFileSync('.cert/cert.pem'), key: readFileSync('.cert/key.pem') }
    : undefined
  return { plugins: [vue()], server: { strictPort: true, https } }
})
