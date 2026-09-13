import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const env = loadEnv(mode, projectRoot, "");
  const value = (name: string, fallback: string) => process.env[name] ?? env[name] ?? fallback;
  const apiOrigin = httpOrigin(
    value("BIM_STUDIO_API_ORIGIN", `http://127.0.0.1:${value("API_PORT", "4100")}`),
    "BIM_STUDIO_API_ORIGIN",
  );
  const httpsEnabled = value("BIM_STUDIO_HTTPS", "false") === "true";
  const sceneViewerOutDir = process.env.VITE_SCENE_VIEWER_BUILD === "true"
    ? process.env.VITE_SCENE_VIEWER_OUT_DIR?.trim()
    : undefined;
  const keyPath = resolve(projectRoot, value("BIM_STUDIO_HTTPS_KEY", "https/private.key"));
  const certificatePath = resolve(projectRoot, value("BIM_STUDIO_HTTPS_CERT", "https/self-sign.cert"));
  if (httpsEnabled && (!existsSync(keyPath) || !existsSync(certificatePath))) {
    throw new Error(`HTTPS certificate not found. Expected ${keyPath} and ${certificatePath}`);
  }
  return {
    plugins: [react()],
    test: {
      // scripts/*.test.mjs 是 node:test 门禁脚本（真实浏览器长跑），不归 vitest 收集。
      exclude: ["**/node_modules/**", "**/dist/**", "scripts/**"],
    },
    resolve: {
      alias: {
        "monaco-editor/esm/vs/editor/editor.worker.js": resolve(projectRoot, "apps/web/node_modules/monaco-editor/esm/vs/editor/editor.worker.js"),
        "monaco-editor/esm/vs/language/typescript/ts.worker.js": resolve(projectRoot, "apps/web/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js")
      }
    },
    server: {
      host: value("BIM_STUDIO_WEB_HOST", "0.0.0.0"),
      port: boundedPort(value("BIM_STUDIO_WEB_PORT", "5173"), 5173),
      strictPort: true,
      ...(httpsEnabled ? { https: { key: readFileSync(keyPath), cert: readFileSync(certificatePath) } } : {}),
      proxy: {
        "/api": { target: apiOrigin, ws: true },
        "/assets": apiOrigin,
        "/health": apiOrigin,
      }
    },
    build: {
      ...(sceneViewerOutDir
        ? {
            // 发布器会先清理自己的包级目录；Vite 不得清理普通 Web 产物或其它工作区文件。
            outDir: resolve(sceneViewerOutDir),
            emptyOutDir: false,
          }
        : {}),
      manifest: true,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              // 固定高成本共享运行时的分包边界，避免源码模块重排导致主入口体积无规律波动。
              {
                name: "three-runtime",
                test: /node_modules[\\/]three[\\/]/,
                priority: 20,
                entriesAware: true,
                entriesAwareMergeThreshold: 20_000
              },
              { name: "archive-runtime", test: /node_modules[\\/]jszip[\\/]/, priority: 20 }
            ]
          }
        }
      }
    }
  };
});

function httpOrigin(value: string, variableName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} 必须是完整的 HTTP(S) 地址`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${variableName} 必须是不含账号、路径、查询参数或片段的 HTTP(S) Origin`);
  }
  return parsed.origin;
}

function boundedPort(value: string, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}
