import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const excludedDirectories = new Set(["dist", "generated", "node_modules"]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    if (entry.isDirectory()) {
      return excludedDirectories.has(entry.name)
        ? Promise.resolve([])
        : sourceFiles(path.join(directory, entry.name));
    }
    return Promise.resolve(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      ? [path.join(directory, entry.name)]
      : []);
  }));
  return nested.flat();
}

describe("web architecture boundary", () => {
  it("uses package public APIs instead of package source deep imports", async () => {
    const root = path.resolve(import.meta.dirname);
    const files = await sourceFiles(root);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/from\s+["']@bim-studio\/(?:studio-core|server-sdk)\//.test(source)) {
        violations.push(path.relative(root, file));
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
    const files = (await sourceFiles(root)).filter((file) => {
      const relative = path.relative(root, file);
      return !exceptions.has(relative)
        && !relative.startsWith(`adapters${path.sep}`)
        && !relative.endsWith(".test.ts")
        && !relative.endsWith(".test.tsx");
    });
    const violations: string[] = [];
    for (const file of files) {
      if (/\bfetch\s*\(/.test(await readFile(file, "utf8"))) violations.push(path.relative(root, file));
    }
    expect(violations).toEqual([]);
  });
});
