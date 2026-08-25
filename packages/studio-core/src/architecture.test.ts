import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const forbidden = /from\s+["'](?:react(?:-dom)?(?:\/[^"']*)?|three(?:\/[^"']*)?|@tauri-apps\/[^"']*|node:https?)["']|\bfetch\s*\(|\bwindow\b|\bglobalThis\s*\.\s*document\b|\bdocument\s*\.\s*(?:body|cookie|createElement|getElementById|querySelector|querySelectorAll)\b/;

describe("studio-core dependency direction", () => {
  it("detects DOM globals without rejecting application document variables", () => {
    expect(forbidden.test("const document = loadApplicationDocument();")).toBe(false);
    expect(forbidden.test("document.createElement('canvas');")).toBe(true);
    expect(forbidden.test("globalThis.document.body.append(node);")).toBe(true);
  });

  it("does not import UI, renderer, host, or network implementations", async () => {
    const directory = path.resolve(import.meta.dirname);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(directory, file), "utf8");
      if (forbidden.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
