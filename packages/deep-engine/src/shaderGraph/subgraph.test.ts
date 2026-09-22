import { describe, expect, it } from "vitest";
import { buildShaderGraphDependencyManifest, type ShaderGraphSubGraphAssetV1 } from "./subgraph.js";
import type { ShaderGraphAssetV1 } from "./graphTypes.js";

const graph = (id: string): ShaderGraphAssetV1 => ({ schemaVersion: 1, id, target: "webgpu-forward",
  properties: [], stages: [], dependencies: [] });
const sub = (id: string, dependencies: readonly string[] = []): ShaderGraphSubGraphAssetV1 => ({
  schemaVersion: 1, id, inputs: [], outputs: [], graph: graph(id), dependencies,
});

describe("shader graph subgraph dependency contract", () => {
  it("builds deterministic, hash-bound dependency manifests", () => {
    const root = sub("root", ["b", "a", "a"]), assets = new Map([[
      "root", root], ["a", sub("a")], ["b", sub("b", ["a"])]]);
    const manifest = buildShaderGraphDependencyManifest(root, id => assets.get(id));
    expect(manifest.root).toBe("root");
    expect(manifest.assets.map(asset => asset.id)).toEqual(["a", "b", "root"]);
    expect(manifest.assets.every(asset => /^[0-9a-f]{64}$/.test(asset.hash))).toBe(true);
  });
  it("rejects missing dependencies and cycles before lowering", () => {
    expect(() => buildShaderGraphDependencyManifest(sub("root", ["missing"]), id => id === "root" ? sub("root", ["missing"]) : undefined))
      .toThrow(/missing/);
    const assets = new Map([["root", sub("root", ["a"])], ["a", sub("a", ["root"])]]);
    expect(() => buildShaderGraphDependencyManifest(assets.get("root")!, id => assets.get(id))).toThrow(/cycle/);
  });
});
