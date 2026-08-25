import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsIdentifier,
  forbiddenNetworkCapabilities,
  hasDomHostReference,
  isAllowedPurePackageImport,
  moduleSpecifiers,
  typescriptSourceFiles
} from "../../../scripts/architectureAnalysis.js";
import { SCENE_CAPABILITIES, SCENE_PERMISSIONS } from "./protocol.js";

const allowedExternalModules = new Set(["@bim-studio/contracts"]);

describe("scene-sdk architecture boundary", () => {
  it("detects hosted, bound, assigned, and chained network capabilities", () => {
    expect(forbiddenNetworkCapabilities(`
      const host = window;
      const boundRequest = host.fetch.bind(host);
      let assignedRequest;
      assignedRequest = boundRequest;
      assignedRequest("/api/data");
      const Socket = globalThis.WebSocket;
      new Socket("wss://example.invalid");
      const { XMLHttpRequest: Request } = globalThis;
      new Request();
      new window.EventSource("/events");
    `)).toEqual(["EventSource", "WebSocket", "XMLHttpRequest", "fetch"]);
  });

  it("recursively keeps production TypeScript independent from UI, renderer, host, and network runtimes", () => {
    const sourceDirectory = path.resolve(import.meta.dirname);
    const packageJson = JSON.parse(readFileSync(path.resolve(sourceDirectory, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const violations: string[] = [];
    for (const file of typescriptSourceFiles(sourceDirectory)) {
      const source = readFileSync(file, "utf8");
      const forbiddenImports = moduleSpecifiers(source, file)
        .filter((specifier) => !isAllowedPurePackageImport(specifier, allowedExternalModules));
      if (forbiddenImports.length > 0
        || forbiddenNetworkCapabilities(source, file).length > 0
        || hasDomHostReference(source, file)
        || containsIdentifier(source, "ViewerEngine", file)) {
        violations.push(path.relative(sourceDirectory, file));
      }
    }
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([...allowedExternalModules].sort());
    expect(isAllowedPurePackageImport("undici", allowedExternalModules)).toBe(false);
    expect(violations).toEqual([]);
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

function findExecutableValue(value: unknown, valuePath = "$", seen = new WeakSet<object>()): string | undefined {
  if (typeof value === "function") return valuePath;
  if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const found = findExecutableValue(Reflect.get(value, key), `${valuePath}.${String(key)}`, seen);
    if (found) return found;
  }
  return undefined;
}
