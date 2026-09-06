import { ROBOT_RESOURCE_PREFIX, RobotResourceScope, safeRobotPath } from "./urdfPackageResources";

type GltfData = { asset?: { version?: string }; buffers?: { uri?: string; byteLength: number }[]; bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[]; images?: { uri?: string; bufferView?: number; mimeType?: string }[]; extensionsRequired?: string[] };

/** 将内嵌 bufferView 图片也注册到本包 scope，避免对未知 blob: 或任意网络 URI 开白名单。 */
export function prepareRobotGltf(bytes: Uint8Array<ArrayBuffer>, path: string, scope: RobotResourceScope): string {
  let json: GltfData, binary: Uint8Array<ArrayBuffer> | undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === 0x46546c67) {
    if (view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new Error("机器人 GLB 头无效");
    let offset = 12, source: string | undefined;
    while (offset + 8 <= bytes.byteLength) {
      const length = view.getUint32(offset, true), kind = view.getUint32(offset + 4, true); offset += 8;
      if (offset + length > bytes.byteLength) throw new Error("机器人 GLB 数据段越界");
      const chunk = bytes.slice(offset, offset + length);
      if (kind === 0x4e4f534a) source = new TextDecoder().decode(chunk);
      if (kind === 0x004e4942) binary = chunk;
      offset += length;
    }
    if (!source || offset !== bytes.byteLength) throw new Error("机器人 GLB 数据段无效");
    json = JSON.parse(source) as GltfData;
  } else json = JSON.parse(new TextDecoder().decode(bytes)) as GltfData;
  if (json.asset?.version !== "2.0") throw new Error("机器人网格需使用 glTF 2.0");
  const base = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const readUri = (uri: string): Uint8Array<ArrayBuffer> => {
    if (uri.startsWith("data:")) {
      const match = /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
      if (!match) throw new Error("机器人 glTF 内嵌资源类型不支持");
      const data = atob(match[1]!); return Uint8Array.from(data, char => char.charCodeAt(0));
    }
    return scope.bytes(safeRobotPath(base + uri));
  };
  const buffers = (json.buffers ?? []).map((buffer, index) => {
    const data = buffer.uri ? readUri(buffer.uri) : index === 0 ? binary : undefined;
    if (!data || data.byteLength < buffer.byteLength) throw new Error("机器人 glTF 缺少完整缓冲区");
    buffer.uri = scope.own(data); return data;
  });
  for (const image of json.images ?? []) {
    let data: Uint8Array<ArrayBuffer>;
    if (image.uri) data = readUri(image.uri);
    else {
      const range = json.bufferViews?.[image.bufferView ?? -1], buffer = range && buffers[range.buffer];
      if (!range || !buffer || !Number.isInteger(range.byteLength) || range.byteLength < 0 || (range.byteOffset ?? 0) < 0 || (range.byteOffset ?? 0) + range.byteLength > buffer.byteLength) throw new Error("机器人 glTF 图片范围无效");
      data = buffer.slice(range.byteOffset ?? 0, (range.byteOffset ?? 0) + range.byteLength);
    }
    image.uri = scope.own(data, image.mimeType); delete image.bufferView;
  }
  // 子 URI 已全部变为本 scope 的 URL；不允许 loader 通过扩展再发起外部文件读取。
  const serialized = JSON.stringify(json);
  if (/"uri"\s*:\s*"(?!blob:)/.test(serialized) || serialized.includes(ROBOT_RESOURCE_PREFIX)) throw new Error("机器人 glTF 含未解析的外部资源");
  return serialized;
}
