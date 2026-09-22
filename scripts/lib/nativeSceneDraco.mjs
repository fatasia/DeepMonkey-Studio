import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";

let io;
/** 仅消除压缩编码，材质等语义继续由 Native 解码器逐项校验。 */
export async function normalizeNativeSceneDraco(bytes, signal) {
  signal.throwIfAborted();
  if (bytes.length < 20) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) return bytes;
  const length = view.getUint32(12, true);
  if (length > bytes.length - 20) throw new Error("GLB JSON 区块越界");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  if (![...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])].includes("KHR_draco_mesh_compression")) return bytes;
  // 拒绝外部 URI：发布编译只消费服务器冻结的单文件 GLB。
  if ([...(json.buffers ?? []), ...(json.images ?? [])].some(item => item.uri)) throw new Error("Native 压缩模型不能引用外部资源");
  io ??= draco.createDecoderModule().then(decoder => new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": decoder }));
  const reader = await io, document = await reader.readBinary(bytes);
  signal.throwIfAborted();
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  const result = await reader.writeBinary(document);
  signal.throwIfAborted();
  return result;
}
