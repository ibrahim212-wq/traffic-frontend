import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  
  // Development server configuration
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  
  // Build configuration for production
  build: {
    outDir: 'dist',
    sourcemap: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true, // Remove console.log in production
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          deckgl: ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/react', '@deck.gl/aggregation-layers'],
          maplibre: ['maplibre-gl'],
          recharts: ['recharts'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  
  // Base path for deployment (root by default for Vercel)
  base: '/',
  
  // Environment variables prefix
  envPrefix: 'VITE_',
})
