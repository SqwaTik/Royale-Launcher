import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false,
    minify: 'esbuild',
    modulePreload: {
      polyfill: false
    },
    assetsInlineLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom']
        }
      }
    }
  }
})
