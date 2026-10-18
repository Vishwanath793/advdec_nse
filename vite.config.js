import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true, // allow ngrok / external tunnel hostnames
    proxy: {
      // xfwd passes the page's host on (X-Forwarded-Host): the backend only accepts
      // order and Kite requests from the same site, and the proxy rewrites Host.
      '/api': { target: 'http://localhost:3001', changeOrigin: true, xfwd: true },
    },
  },
});
