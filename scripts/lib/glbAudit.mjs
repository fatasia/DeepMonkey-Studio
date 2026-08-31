import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const MAX_JSON_BYTES = 64 * 1024 * 1024;

export async function inspectGlbFile(filePath, bytes) {
  const sha256 = await hashFile(filePath);
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < header.length) return invalidResult(bytes, sha256, "GLB 文件头不完整");
    if (header.readUInt32LE(0) !== GLB_MAGIC) return invalidResult(bytes, sha256, "不是 GLB 文件");
    if (header.readUInt32LE(4) !== 2) return invalidResult(bytes, sha256, "仅支持 GLB 2.0");
    if (header.readUInt32LE(8) !== bytes) return invalidResult(bytes, sha256, "GLB 声明长度与实际文件不一致");
    const jsonLength = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== JSON_CHUNK) return invalidResult(bytes, sha256, "首个 GLB 数据块不是 JSON");
    if (jsonLength <= 0 || jsonLength > MAX_JSON_BYTES || jsonLength + 20 > bytes) {
      return invalidResult(bytes, sha256, "GLB JSON 数据块长度异常");
    }
    const jsonBuffer = Buffer.alloc(jsonLength);
    const jsonRead = await handle.read(jsonBuffer, 0, jsonLength, 20);
    if (jsonRead.bytesRead !== jsonLength) return invalidResult(bytes, sha256, "GLB JSON 数据块读取不完整");
    const document = JSON.parse(jsonBuffer.toString("utf8").replace(/[\0\s]+$/u, ""));
    const metrics = summarizeGlbDocument(document);
    return { valid: true, bytes, sha256, ...metrics, qualityTier: classifyQuality(bytes, metrics) };
  } catch (error) {
    return invalidResult(bytes, sha256, error instanceof Error ? error.message : String(error));
  } finally {
    await handle.close();
  }
}

export function summarizeGlbDocument(document) {
  const accessors = Array.isArray(document.accessors) ? document.accessors : [];
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  let triangleCount = 0;
  let primitiveCount = 0;
  const bounds = emptyBounds();
  for (const mesh of meshes) {
    for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      primitiveCount += 1;
      const mode = primitive?.mode ?? 4;
      const indexAccessor = Number.isInteger(primitive?.indices) ? accessors[primitive.indices] : undefined;
      const positionAccessor = Number.isInteger(primitive?.attributes?.POSITION) ? accessors[primitive.attributes.POSITION] : undefined;
      const elementCount = finiteCount(indexAccessor?.count ?? positionAccessor?.count);
      if (mode === 4) triangleCount += Math.floor(elementCount / 3);
      else if (mode === 5 || mode === 6) triangleCount += Math.max(0, elementCount - 2);
      includeAccessorBounds(bounds, positionAccessor);
    }
  }
  const externalUris = [...(document.buffers ?? []), ...(document.images ?? [])]
    .map((item) => item?.uri)
    .filter((uri) => typeof uri === "string" && !uri.startsWith("data:"));
  return {
    generator: typeof document.asset?.generator === "string" ? document.asset.generator.slice(0, 160) : undefined,
    sceneCount: Array.isArray(document.scenes) ? document.scenes.length : 0,
    nodeCount: Array.isArray(document.nodes) ? document.nodes.length : 0,
    meshCount: meshes.length,
    primitiveCount,
    materialCount: Array.isArray(document.materials) ? document.materials.length : 0,
    textureCount: Array.isArray(document.textures) ? document.textures.length : 0,
    animationCount: Array.isArray(document.animations) ? document.animations.length : 0,
    triangleCount,
    externalUris,
    extensionsUsed: stringArray(document.extensionsUsed),
    extensionsRequired: stringArray(document.extensionsRequired),
    dimensions: bounds.valid
      ? { x: bounds.max[0] - bounds.min[0], y: bounds.max[1] - bounds.min[1], z: bounds.max[2] - bounds.min[2] }
      : undefined,
  };
}

export function classifyQuality(bytes, metrics) {
  if (metrics.externalUris.length > 0 || metrics.meshCount === 0) return "review";
  if (bytes > 50 * 1024 * 1024 || metrics.triangleCount > 2_000_000) return "heavy";
  if (bytes <= 5 * 1024 * 1024 && metrics.triangleCount <= 250_000) return "light";
  return "standard";
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function invalidResult(bytes, sha256, reason) {
  return { valid: false, bytes, sha256, qualityTier: "invalid", reason };
}

function includeAccessorBounds(bounds, accessor) {
  if (!Array.isArray(accessor?.min) || !Array.isArray(accessor?.max) || accessor.min.length < 3 || accessor.max.length < 3) return;
  for (let axis = 0; axis < 3; axis += 1) {
    const min = Number(accessor.min[axis]);
    const max = Number(accessor.max[axis]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    bounds.min[axis] = Math.min(bounds.min[axis], min);
    bounds.max[axis] = Math.max(bounds.max[axis], max);
  }
  bounds.valid = true;
}

function emptyBounds() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], valid: false };
}

function finiteCount(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 64) : [];
}
