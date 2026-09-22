import type { ShaderGraphAssetV1 } from "./graphTypes.js";
import { canonicalShaderGraphJson, shaderGraphHash } from "./graphSerialization.js";

export interface ShaderGraphSubGraphInput {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}
export interface ShaderGraphSubGraphOutput {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}
export interface ShaderGraphSubGraphAssetV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly label?: string;
  readonly inputs: readonly ShaderGraphSubGraphInput[];
  readonly outputs: readonly ShaderGraphSubGraphOutput[];
  readonly graph: ShaderGraphAssetV1;
  readonly dependencies: readonly string[];
}
export interface ShaderGraphDependencyManifest {
  readonly root: string;
  readonly assets: readonly { readonly id: string; readonly hash: string }[];
}

/** 构建稳定的 SubGraph 依赖清单；资产本身不被展开或复制。 */
export function buildShaderGraphDependencyManifest(root: ShaderGraphSubGraphAssetV1,
  resolve: (id: string) => ShaderGraphSubGraphAssetV1 | undefined): ShaderGraphDependencyManifest {
  const visited = new Set<string>(), active = new Set<string>();
  const assets: { id: string; hash: string }[] = [];
  const visit = (asset: ShaderGraphSubGraphAssetV1): void => {
    if (active.has(asset.id)) throw new Error(`Shader SubGraph dependency cycle at ${asset.id}.`);
    if (visited.has(asset.id)) return;
    active.add(asset.id);
    const dependencyIds = [...new Set(asset.dependencies)].sort();
    for (const id of dependencyIds) {
      const dependency = resolve(id);
      if (!dependency) throw new Error(`Shader SubGraph dependency ${id} is missing.`);
      visit(dependency);
    }
    active.delete(asset.id); visited.add(asset.id);
    assets.push({ id: asset.id, hash: shaderGraphHash(asset.graph) });
  };
  visit(root);
  assets.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return Object.freeze({ root: root.id, assets: Object.freeze(assets) });
}

export function canonicalShaderGraphSubGraphJson(asset: ShaderGraphSubGraphAssetV1): string {
  return canonicalShaderGraphJson(asset.graph);
}
