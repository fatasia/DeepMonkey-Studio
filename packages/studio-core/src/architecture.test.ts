import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  forbiddenNetworkCapabilities,
  hasDomHostReference,
  isAllowedPurePackageImport,
  moduleSpecifiers,
  typescriptSourceFiles
} from "../../../scripts/architectureAnalysis.js";

const allowedExternalModules = new Set(["@bim-studio/contracts"]);

describe("studio-core dependency direction", () => {
  it("detects DOM globals without rejecting application document variables", () => {
    expect(hasDomHostReference("const document = loadApplicationDocument();")).toBe(false);
    expect(hasDomHostReference("document.createElement('canvas');")).toBe(true);
    expect(hasDomHostReference("globalThis.document.body.append(node);")).toBe(true);
  });

  it("detects hosted, bound, assigned, and chained network capabilities", () => {
    expect(forbiddenNetworkCapabilities(`
      const host = globalThis;
      const boundRequest = host.fetch.bind(host);
      let assignedRequest;
      assignedRequest = boundRequest;
      assignedRequest("/api/data");
      const { WebSocket: Socket } = window;
      new Socket("wss://example.invalid");
      new globalThis.XMLHttpRequest();
      const Events = EventSource;
      new Events("/events");
    `)).toEqual(["EventSource", "WebSocket", "XMLHttpRequest", "fetch"]);
  });

  it("recursively rejects UI, renderer, host, and network dependencies through every import form", async () => {
    const directory = path.resolve(import.meta.dirname);
    const packageJson = JSON.parse(await readFile(path.resolve(directory, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const violations: string[] = [];
    for (const file of typescriptSourceFiles(directory)) {
      const source = await readFile(file, "utf8");
      const forbiddenImports = moduleSpecifiers(source, file)
        .filter((specifier) => !isAllowedPurePackageImport(specifier, allowedExternalModules));
      if (forbiddenImports.length > 0 || forbiddenNetworkCapabilities(source, file).length > 0 || hasDomHostReference(source, file)) {
        violations.push(path.relative(directory, file));
      }
    }
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([...allowedExternalModules].sort());
    expect(isAllowedPurePackageImport("undici", allowedExternalModules)).toBe(false);
    expect(violations).toEqual([]);
  });
});
