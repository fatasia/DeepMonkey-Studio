import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const env = loadEnv(mode, projectRoot, "");
  const value = (name: string, fallback: string) => process.env[name] ?? env[name] ?? fallback;
  const httpsEnabled = value("BIM_STUDIO_HTTPS", "false") === "true";
  const keyPath = resolve(projectRoot, value("BIM_STUDIO_HTTPS_KEY", "https/private.key"));
  const certificatePath = resolve(projectRoot, value("BIM_STUDIO_HTTPS_CERT", "https/self-sign.cert"));
  if (httpsEnabled && (!existsSync(keyPath) || !existsSync(certificatePath))) {
    throw new Error(`HTTPS certificate not found. Expected ${keyPath} and ${certificatePath}`);
  }
  return {
    plugins: [react()],
    server: {
      host: value("BIM_STUDIO_WEB_HOST", "0.0.0.0"),
      port: 5173,
      ...(httpsEnabled ? { https: { key: readFileSync(keyPath), cert: readFileSync(certificatePath) } } : {}),
      proxy: {
        "/api": "http://localhost:4100",
        "/assets": "http://localhost:4100",
        "/health": "http://localhost:4100",
        "/node-red": "http://localhost:1880",
        "/iot": { target: "http://localhost:1880", ws: true }
      }
    }
  };
});
