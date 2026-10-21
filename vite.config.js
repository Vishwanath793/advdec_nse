import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend's port (server/index.js reads PORT). Set BACKEND_PORT when another
// app on this PC already uses 3001, e.g. BACKEND_PORT=3002 with PORT=3002.
const backendPort = Number(process.env.BACKEND_PORT) || 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true, // allow ngrok / external tunnel hostnames
    proxy: {
      // xfwd passes the page's host on (X-Forwarded-Host): the backend only accepts
      // order and Kite requests from the same site, and the proxy rewrites Host.
      '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true, xfwd: true },
    },
  },
});
