import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findDependencyCycles,
  forbiddenNetworkCapabilities,
  isWorkspacePackageSourceDeepImport,
  moduleSpecifiers,
  typescriptSourceFiles,
  workspaceDependencyCycles
} from "../../../scripts/architectureAnalysis.js";

describe("web architecture boundary", () => {
  it("parses static, side-effect, export-from, and dynamic string imports with the TypeScript AST", () => {
    expect(moduleSpecifiers(`
      import value from "static-package";
      import "side-effect-package";
      export { value } from "export-package";
      void import("dynamic-package");
      void import("dynamic-options-package", { with: { type: "json" } });
      type External = import("type-package").External;
    `)).toEqual(["static-package", "side-effect-package", "export-package", "dynamic-package", "dynamic-options-package", "type-package"]);
  });

  it("detects package-spelled and cross-package relative source deep imports", () => {
    const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
    const webFile = path.join(workspaceRoot, "apps", "web", "src", "feature.ts");
    const contractsFile = path.join(workspaceRoot, "packages", "contracts", "src", "application.ts");

    expect(isWorkspacePackageSourceDeepImport("@bim-studio/contracts/src/application.js", webFile, workspaceRoot)).toBe(true);
    expect(isWorkspacePackageSourceDeepImport("../../../packages/scene-sdk/src/protocol.js", webFile, workspaceRoot)).toBe(true);
    expect(isWorkspacePackageSourceDeepImport("./resourceId.js", contractsFile, workspaceRoot)).toBe(false);
    expect(moduleSpecifiers(`
      import "@bim-studio/contracts/src/application.js";
      void import("../../../packages/scene-sdk/src/protocol.js", { with: { type: "json" } });
    `)).toHaveLength(2);
  });

  it("recursively uses public package APIs, including scene-sdk", async () => {
    const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
    const violations: string[] = [];
    for (const sourceRoot of [path.join(workspaceRoot, "apps"), path.join(workspaceRoot, "packages")]) {
      for (const file of typescriptSourceFiles(sourceRoot, true)) {
        const source = await readFile(file, "utf8");
        if (moduleSpecifiers(source, file).some((specifier) =>
          isWorkspacePackageSourceDeepImport(specifier, file, workspaceRoot))) {
          violations.push(path.relative(workspaceRoot, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps raw HTTP transport inside api.ts and documented non-business asset boundaries", async () => {
    const root = path.resolve(import.meta.dirname);
    const exceptions = new Set([
      "api.ts",
      "sceneFiles.ts",
      path.join("viewer", "ViewerEngine.ts"),
      path.join("optimizer", "modelOptimizer.ts")
    ]);
    const violations: string[] = [];
    for (const file of typescriptSourceFiles(root)) {
      const relative = path.relative(root, file);
      if (exceptions.has(relative) || relative.startsWith(`adapters${path.sep}`)) continue;
      if (forbiddenNetworkCapabilities(await readFile(file, "utf8"), file).length > 0) violations.push(relative);
    }
    expect(violations).toEqual([]);
  });

  it("detects hosted transports and obvious aliases or destructuring", () => {
    expect(forbiddenNetworkCapabilities(`
      globalThis.fetch("/api/direct");
      window.fetch("/api/window");
      const request = globalThis.fetch;
      request("/api/alias");
      const { fetch: destructuredRequest } = globalThis;
      destructuredRequest("/api/destructured");
      const Socket = WebSocket;
      new Socket("wss://example.invalid");
      new globalThis.XMLHttpRequest();
      const Events = window.EventSource;
      new Events("/events");
    `)).toEqual(["EventSource", "WebSocket", "XMLHttpRequest", "fetch"]);
  });

  it("keeps workspace package dependencies acyclic", () => {
    const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
    expect(workspaceDependencyCycles(workspaceRoot)).toEqual([]);
    expect(findDependencyCycles(new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]]
    ]))).toEqual([["a", "b", "c", "a"]]);
  });
});
