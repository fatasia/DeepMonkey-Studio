import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasCallToIdentifier,
  hasDomHostReference,
  moduleSpecifiers,
  typescriptSourceFiles
} from "../../../scripts/architectureAnalysis.js";

const forbiddenModule = /^(?:react(?:-dom)?(?:\/|$)|three(?:\/|$)|@tauri-apps\/|node:https?$)/;

describe("studio-core dependency direction", () => {
  it("detects DOM globals without rejecting application document variables", () => {
    expect(hasDomHostReference("const document = loadApplicationDocument();")).toBe(false);
    expect(hasDomHostReference("document.createElement('canvas');")).toBe(true);
    expect(hasDomHostReference("globalThis.document.body.append(node);")).toBe(true);
  });

  it("recursively rejects UI, renderer, host, and network dependencies through every import form", async () => {
    const directory = path.resolve(import.meta.dirname);
    const violations: string[] = [];
    for (const file of typescriptSourceFiles(directory)) {
      const source = await readFile(file, "utf8");
      const forbiddenImports = moduleSpecifiers(source, file).filter((specifier) => forbiddenModule.test(specifier));
      if (forbiddenImports.length > 0 || hasCallToIdentifier(source, "fetch", file) || hasDomHostReference(source, file)) {
        violations.push(path.relative(directory, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
