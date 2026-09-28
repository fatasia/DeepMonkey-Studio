import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { checkTsDistFreshness } from "./tsArtifactFreshness.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ts-artifact-freshness-"));
  const name = "contracts";
  const dir = path.join(root, "packages", name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2023", module: "ESNext", declaration: true, rootDir: "src", outDir: "dist" },
    include: ["src/**/*.ts"],
  }));
  const source = path.join(dir, "src", "runtime.ts");
  writeFileSync(source, `export interface Runtime { readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 7; readonly entrypoints: { readonly dynamicRuntime?: string }; }\nexport const parse = (value: Runtime) => value.schemaVersion === 7 ? 1 : 0;\n`);
  const build = () => {
    const config = ts.readConfigFile(path.join(dir, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    const result = program.emit(undefined, (file, text) => writeFileSync(file, text));
    assert.equal(result.emitSkipped, false);
  };
  build();
  return { root, dir, source, build, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("TS dist detects non-field semantics, versioned ABI, missing and extra files without writing dist", async () => {
  const f = fixture();
  try {
    assert.deepEqual((await checkTsDistFreshness(f.root, "contracts")).stale, []);
    const dist = path.join(f.dir, "dist", "runtime.js");
    const baseline = readFileSync(dist);
    const source = readFileSync(f.source, "utf8");
    writeFileSync(f.source, source.replace("? 1 : 0", "? 2 : 0"));
    let result = await checkTsDistFreshness(f.root, "contracts");
    assert.ok(result.stale.some(entry => entry.field === "内容不匹配 runtime.js"));
    assert.deepEqual(readFileSync(dist), baseline, "read-only gate must not repair build output");
    f.build();
    assert.deepEqual((await checkTsDistFreshness(f.root, "contracts")).stale, []);
    writeFileSync(f.source, readFileSync(f.source, "utf8").replace("dynamicRuntime?: string", "dynamicRuntime?: number"));
    result = await checkTsDistFreshness(f.root, "contracts");
    assert.ok(result.stale.some(entry => entry.field === "内容不匹配 runtime.d.ts"));
    f.build();
    assert.deepEqual((await checkTsDistFreshness(f.root, "contracts")).stale, []);
    writeFileSync(path.join(f.dir, "dist", "obsolete.js"), "stale");
    assert.ok((await checkTsDistFreshness(f.root, "contracts")).stale.some(entry => entry.field === "多余 obsolete.js"));
    rmSync(path.join(f.dir, "dist", "obsolete.js"));
    rmSync(dist);
    assert.ok((await checkTsDistFreshness(f.root, "contracts")).stale.some(entry => entry.field === "缺少 runtime.js"));
  } finally { f.dispose(); }
});

test("TS dist does not report stale when source changes without changing emitted ABI or JS", async () => {
  const f = fixture();
  try {
    writeFileSync(f.source, readFileSync(f.source, "utf8").replace("export interface Runtime", "/* documentation only */ export interface Runtime"));
    assert.deepEqual((await checkTsDistFreshness(f.root, "contracts")).stale, []);
    writeFileSync(path.join(f.dir, "src", "second.ts"), "export const second = 7;\n");
    assert.ok((await checkTsDistFreshness(f.root, "contracts")).stale.some(entry => entry.field === "缺少 second.d.ts"));
  } finally { f.dispose(); }
});

test("TS dist fails closed on invalid source or missing configuration", async () => {
  const f = fixture();
  try {
    writeFileSync(f.source, "export const invalid = ;\n");
    await assert.rejects(checkTsDistFreshness(f.root, "contracts"), /内存编译失败/);
    await assert.rejects(checkTsDistFreshness(f.root, "deep-engine"), /Cannot read file|File .* not found|not found/i);
  } finally { f.dispose(); }
});
