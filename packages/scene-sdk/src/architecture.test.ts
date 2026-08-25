import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENE_CAPABILITIES, SCENE_PERMISSIONS } from "./protocol.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const forbiddenReferences = [
  /["']react(?:\/[^"']*)?["']/,
  /["']react-dom(?:\/[^"']*)?["']/,
  /["']three(?:\/[^"']*)?["']/,
  /\bViewerEngine\b/,
  /@tauri-apps\//,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bfetch\b/,
  /["']node:http["']/,
  /["']node:https["']/
] as const;

describe("scene-sdk architecture boundary", () => {
  it("keeps production TypeScript independent from UI, renderer, host, and network runtimes", () => {
    for (const file of productionTypeScriptFiles(sourceDirectory)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenReferences) {
        expect(source, `${file} contains forbidden reference ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("keeps runtime protocol fixtures pure serializable data", () => {
    const fixtures = {
      capabilities: SCENE_CAPABILITIES,
      permissions: SCENE_PERMISSIONS,
      objectRefs: [
        { kind: "scene", sceneId: "scene:1" },
        { kind: "object", sceneId: "scene:1", objectId: "object:1" },
        { kind: "mesh", sceneId: "scene:1", objectId: "object:1", meshId: "mesh:1" }
      ],
      manifest: {
        id: "com.example.extension",
        name: "Example",
        version: "1.0.0",
        apiVersion: "1.0",
        entry: "dist/index.js",
        execution: "worker-sandbox",
        capabilities: ["studio.scene"],
        permissions: ["scene.read"],
        hosts: ["browser"],
        renderers: ["webgl2"],
        lifecycle: ["onStart", "onDispose"]
      }
    };

    expect(findExecutableValue(fixtures)).toBeUndefined();
    expect(structuredClone(fixtures)).toEqual(fixtures);
    expect(JSON.parse(JSON.stringify(fixtures))).toEqual(fixtures);
  });
});

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (extname(entry.name) !== ".ts" || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

function findExecutableValue(value: unknown, path = "$", seen = new WeakSet<object>()): string | undefined {
  if (typeof value === "function") return path;
  if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const found = findExecutableValue(Reflect.get(value, key), `${path}.${String(key)}`, seen);
    if (found) return found;
  }
  return undefined;
}
