import sharp from "sharp";

export interface ClientPackageBranding {
  readonly applicationName?: string;
  readonly iconIco?: Uint8Array;
}

const ICON_LIMIT = 2 * 1024 ** 2;

/** 发布级品牌覆盖；空字段保留播放器默认值，图标字节随 EXE 离线交付。 */
export async function parseClientPackageBranding(value: unknown, signal?: AbortSignal): Promise<ClientPackageBranding> {
  signal?.throwIfAborted();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("客户端品牌设置无效");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["applicationName", "iconDataUrl"].includes(key))) throw new Error("客户端品牌设置包含未知字段");
  let applicationName: string | undefined;
  if (input.applicationName !== undefined) {
    if (typeof input.applicationName !== "string") throw new Error("客户端名称必须为文本");
    applicationName = input.applicationName.trim() || undefined;
    if (applicationName && (applicationName.length > 80 || /[\x00-\x1f\x7f]/.test(applicationName))) throw new Error("客户端名称最多 80 字，不能包含控制字符");
  }
  let iconIco: Uint8Array | undefined;
  if (input.iconDataUrl !== undefined && input.iconDataUrl !== "") {
    if (typeof input.iconDataUrl !== "string" || input.iconDataUrl.length > Math.ceil(ICON_LIMIT / 3) * 4 + 100) throw new Error("图标不能超过 2 MiB");
    const match = /^data:image\/(png|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.iconDataUrl);
    if (!match) throw new Error("图标只支持 PNG 或 ICO");
    const source = Buffer.from(match[2]!, "base64");
    if (source.length > ICON_LIMIT || source.toString("base64") !== match[2]) throw new Error("图标编码或大小无效");
    if (match[1] === "png") {
      const metadata = await sharp(source, { limitInputPixels: 4096 ** 2 }).metadata();
      if (metadata.format !== "png" || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("图标必须是单帧 PNG");
      const images: { size: number; bytes: Buffer }[] = [];
      for (const size of [16, 24, 32, 48, 64, 256]) {
        signal?.throwIfAborted();
        images.push({ size, bytes: await sharp(source, { limitInputPixels: 4096 ** 2 }).resize(size, size, { fit: "contain", background: "#00000000" }).png().toBuffer() });
      }
      const header = Buffer.alloc(6 + images.length * 16);
      header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
      let offset = header.length;
      images.forEach(({ size, bytes }, index) => {
        const entry = 6 + index * 16;
        header[entry] = header[entry + 1] = size === 256 ? 0 : size;
        header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
        offset += bytes.length;
      });
      iconIco = Buffer.concat([header, ...images.map(image => image.bytes)]);
    } else {
      assertClientIcon(source);
      await validateIconImages(source, signal);
      iconIco = source;
    }
  }
  signal?.throwIfAborted();
  return { ...(applicationName ? { applicationName } : {}), ...(iconIco ? { iconIco } : {}) };
}

async function validateIconImages(ico: Buffer, signal?: AbortSignal): Promise<void> {
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    signal?.throwIfAborted();
    const entry = 6 + index * 16, width = ico[entry] || 256, height = ico[entry + 1] || 256;
    const start = ico.readUInt32LE(entry + 12), image = ico.subarray(start, start + ico.readUInt32LE(entry + 8));
    if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const decoded = await sharp(image, { limitInputPixels: 256 ** 2 }).raw().toBuffer({ resolveWithObject: true });
      if (decoded.info.width !== width || decoded.info.height !== height) throw new Error("ICO 图像尺寸与目录不符");
    } else {
      if (image.length < 40) throw new Error("ICO 图像数据无效");
      const header = image.readUInt32LE(0), depth = image.readUInt16LE(14);
      if (![40, 108, 124].includes(header) || image.length < header || image.readInt32LE(4) !== width
        || image.readInt32LE(8) !== height * 2 || image.readUInt16LE(12) !== 1
        || ![1, 4, 8, 16, 24, 32].includes(depth) || image.readUInt32LE(16) !== 0) throw new Error("ICO 位图格式无效");
      const palette = depth <= 8 ? (image.readUInt32LE(32) || 2 ** depth) * 4 : 0;
      const pixels = Math.ceil(width * depth / 32) * 4 * height;
      if (header + palette + pixels > image.length) throw new Error("ICO 位图数据不完整");
    }
  }
}

export function assertClientIcon(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error("ICO 文件头无效");
  const count = bytes.readUInt16LE(4), end = 6 + count * 16;
  if (!count || count > 32 || end > bytes.length) throw new Error("ICO 图像目录无效");
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16, size = bytes.readUInt32LE(entry + 8), start = bytes.readUInt32LE(entry + 12);
    if (!size || start < end || start + size > bytes.length || ranges.some(range => start < range.end && start + size > range.start)) throw new Error("ICO 图像范围无效");
    ranges.push({ start, end: start + size });
  }
}
