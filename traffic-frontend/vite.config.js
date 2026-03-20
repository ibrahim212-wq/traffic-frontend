import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import cesium from 'vite-plugin-cesium'

export default defineConfig({
  plugins: [
    react(),
    cesium(),
    nodePolyfills({
      // Exclude protocol polyfills (we don't need them)
      protocolImports: false,
      // Only polyfill what we need
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      // Exclude Node.js built-ins that we don't need
      exclude: [
        'fs',
        'path',
        'os',
        'crypto',
        'stream',
        'util',
        'url',
        'querystring',
        'events',
        'http',
        'https',
        'net',
        'tls',
        'dns',
        'child_process',
        'worker_threads',
      ],
    }),
  ],
  
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
  
  // Define polyfills for Node.js built-ins
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    // Polyfill for child_process/spawn that loaders.gl tries to use
    'globalThis.process': '{}',
    'globalThis.Buffer': '{}',
  },
  
  // Optimize dependencies for better performance
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'recharts',
    ],
  },
  
  // Build configuration for production
  build: {
    outDir: 'dist',
    sourcemap: true,
    minify: 'terser',
    target: 'es2020',
    // Suppress specific warnings that don't affect functionality
    onwarn(warning, warn) {
      // Suppress the spawn warning from @loaders.gl/worker-utils
      if (warning.code === 'MODULE_NOT_FOUND' && 
          warning.message.includes('spawn') && 
          warning.message.includes('@loaders.gl/worker-utils')) {
        return
      }
      // Suppress browser external warnings
      if (warning.code === 'PLUGIN_WARNING' && 
          warning.message.includes('__vite-browser-external')) {
        return
      }
      warn(warning)
    },
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
      output: {
        manualChunks: {
          vendor:   ['react', 'react-dom'],
          recharts: ['recharts'],
          utils:    ['d3-array', 'd3-scale', 'd3-time-format'],
        },
      },
    },
    chunkSizeWarningLimit: 10000,
  },
  
  // Base path for deployment (root by default for Vercel)
  base: '/',
  
  // Environment variables prefix
  envPrefix: 'VITE_',
})
