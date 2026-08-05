import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4100",
      "/assets": "http://localhost:4100",
      "/health": "http://localhost:4100",
      "/node-red": "http://localhost:1880",
      "/iot": { target: "http://localhost:1880", ws: true }
    }
  }
});
