
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Expose API_KEY to the client for Sandbox/Client-side execution
    // This allows the app to function even if Netlify backend functions are not deployed
    'process.env.API_KEY': JSON.stringify(process.env.API_KEY || ""),
  }
});
