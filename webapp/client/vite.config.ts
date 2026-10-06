import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Use an explicit port so the backend can whitelist it in dev.
const PORT = 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET || "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});