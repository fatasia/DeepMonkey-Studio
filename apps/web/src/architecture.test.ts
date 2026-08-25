import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findDependencyCycles,
  hasCallToIdentifier,
  moduleSpecifiers,
  typescriptSourceFiles,
  workspaceDependencyCycles
} from "../../../scripts/architectureAnalysis.js";

const publicPackageDeepImport = /^@bim-studio\/(?:contracts|server-sdk|studio-core|scene-sdk)\/.+/;

describe("web architecture boundary", () => {
  it("parses static, side-effect, export-from, and dynamic string imports with the TypeScript AST", () => {
    expect(moduleSpecifiers(`
      import value from "static-package";
      import "side-effect-package";
      export { value } from "export-package";
      void import("dynamic-package");
      type External = import("type-package").External;
    `)).toEqual(["static-package", "side-effect-package", "export-package", "dynamic-package", "type-package"]);
  });

  it("recursively uses public package APIs, including scene-sdk", async () => {
    const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
    const violations: string[] = [];
    for (const sourceRoot of [path.join(workspaceRoot, "apps"), path.join(workspaceRoot, "packages")]) {
      for (const file of typescriptSourceFiles(sourceRoot, true)) {
        const source = await readFile(file, "utf8");
        if (moduleSpecifiers(source, file).some((specifier) => publicPackageDeepImport.test(specifier))) {
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
      if (hasCallToIdentifier(await readFile(file, "utf8"), "fetch", file)) violations.push(relative);
    }
    expect(violations).toEqual([]);
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
