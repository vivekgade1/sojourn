import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DAEMON_URL = "http://localhost:4177";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: DAEMON_URL,
        changeOrigin: true,
      },
      "/ws": {
        target: DAEMON_URL,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
