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
  
  // Resolve aliases and externals
  resolve: {
    alias: {
      // Handle Node.js built-ins that mapping libraries might try to import
      'child_process': 'node:child_process',
      'worker_threads': 'node:worker_threads',
      'fs': 'node:fs',
      'path': 'node:path',
      'os': 'node:os',
      'url': 'node:url',
      'util': 'node:util',
    },
  },
  
  // Optimize dependencies and handle Node.js built-ins
  optimizeDeps: {
    exclude: ['@loaders.gl/worker-utils'],
    include: [
      'react',
      'react-dom',
      '@deck.gl/core',
      '@deck.gl/layers',
      '@deck.gl/react',
      '@deck.gl/aggregation-layers',
      'maplibre-gl',
      'recharts',
    ],
  },
  
  // Build configuration for production
  build: {
    outDir: 'dist',
    sourcemap: true,
    minify: 'terser',
    target: 'es2020',
    terserOptions: {
      compress: {
        drop_console: true, // Remove console.log in production
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info', 'console.debug', 'console.warn'],
      },
      mangle: {
        safari10: true,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      external: [
        // Externalize Node.js built-ins
        'child_process',
        'worker_threads',
        'fs',
        'path',
        'os',
        'url',
        'util',
        'crypto',
        'stream',
        'buffer',
      ],
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          deckgl: [
            '@deck.gl/core',
            '@deck.gl/layers',
            '@deck.gl/react',
            '@deck.gl/aggregation-layers',
          ],
          maplibre: ['maplibre-gl'],
          recharts: ['recharts'],
          utils: ['d3-array', 'd3-scale', 'd3-time-format'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  
  // Base path for deployment (root by default for Vercel)
  base: '/',
  
  // Environment variables prefix
  envPrefix: 'VITE_',
  
  // Define global constants
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
})
