import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";

export interface GlbGeometryEvidence {
  meshCount: number;
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
}

interface ConverterOutputEvidence {
  files: string[];
  geometry: GlbGeometryEvidence;
}

/**
 * 转换器产物必须先完成几何和 sidecar 审计，再进入对象存储。
 * 结构探测结果不能替代这里的 GLB 三角几何证据。
 */
export async function auditConverterOutput(
  outputDir: string,
  requireHierarchy: boolean,
): Promise<ConverterOutputEvidence> {
  const files = await readdir(outputDir);
  if (!files.includes("geometry.glb")) throw new Error("转换器未生成必需产物 geometry.glb");
  if (requireHierarchy && !files.includes("hierarchy.json")) {
    throw new Error("工业 CAD 转换器未生成 hierarchy.json，不能保证装配结构可追溯");
  }

  const geometry = await auditGlbGeometry(path.join(outputDir, "geometry.glb"));
  for (const fileName of ["hierarchy.json", "properties.json", "pmi.json"]) {
    if (files.includes(fileName)) await assertJsonObject(path.join(outputDir, fileName), fileName);
  }
  return { files, geometry };
}

export async function auditGlbGeometry(filePath: string): Promise<GlbGeometryEvidence> {
  try {
    const document = await gltfIo().then((io) => io.read(filePath));
    const meshes = document.getRoot().listMeshes();
    let primitiveCount = 0;
    let vertexCount = 0;
    let triangleCount = 0;
    for (const mesh of meshes) {
      for (const primitive of mesh.listPrimitives()) {
        primitiveCount += 1;
        const positions = primitive.getAttribute("POSITION");
        if (!positions || positions.getCount() === 0) throw new Error("存在缺少 POSITION 顶点的图元");
        vertexCount += positions.getCount();
        const elementCount = primitive.getIndices()?.getCount() ?? positions.getCount();
        const mode = primitive.getMode();
        if (mode === 4) triangleCount += Math.floor(elementCount / 3);
        else if (mode === 5 || mode === 6) triangleCount += Math.max(0, elementCount - 2);
      }
    }
    if (meshes.length === 0 || primitiveCount === 0 || triangleCount === 0) {
      throw new Error("未发现可渲染的三角网格");
    }
    return { meshCount: meshes.length, primitiveCount, vertexCount, triangleCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`geometry.glb 几何审计失败：${message}`);
  }
}

async function assertJsonObject(filePath: string, label: string): Promise<void> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("根节点必须是对象");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 审计失败：${message}`);
  }
}

let ioPromise: Promise<NodeIO> | undefined;

function gltfIo(): Promise<NodeIO> {
  ioPromise ??= Promise.all([draco3d.createDecoderModule(), MeshoptDecoder.ready]).then(([decoder]) => new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": decoder, "meshopt.decoder": MeshoptDecoder }));
  return ioPromise;
}
