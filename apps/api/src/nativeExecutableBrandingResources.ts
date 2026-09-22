export interface NativeExecutableBranding { applicationName?: string; iconIco?: Uint8Array }
export interface NativeResource { type: number; id: number; bytes: Buffer }

export function nativeBrandingResources(branding: NativeExecutableBranding): NativeResource[] {
  const resources: NativeResource[] = [];
  if (branding.applicationName !== undefined) {
    const name = branding.applicationName.trim();
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("客户端名称须为 1–80 个无控制字符的文字");
    resources.push({ type: 10, id: 102, bytes: Buffer.from(name, "utf8") });
    resources.push({ type: 16, id: 1, bytes: versionInfo(name) });
  }
  if (branding.iconIco !== undefined) resources.push(...iconResources(Buffer.from(branding.iconIco)));
  return resources;
}

function iconResources(ico: Buffer): NativeResource[] {
  if (ico.length < 22 || ico.length > 4 * 1024 * 1024 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error("客户端 ICO 无效");
  const count = ico.readUInt16LE(4);
  if (count < 1 || count > 32 || 6 + count * 16 > ico.length) throw new Error("客户端 ICO 目录无效");
  const group = Buffer.alloc(6 + count * 14);
  ico.copy(group, 0, 0, 6);
  const resources: NativeResource[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const size = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    if (!size || offset < 6 + count * 16 || offset + size > ico.length) throw new Error("客户端 ICO 图片越界");
    ico.copy(group, 6 + index * 14, entry, entry + 12);
    group.writeUInt16LE(index + 1, 6 + index * 14 + 12);
    resources.push({ type: 3, id: index + 1, bytes: Buffer.from(ico.subarray(offset, offset + size)) });
  }
  resources.push({ type: 14, id: 101, bytes: group });
  return resources;
}

function block(key: string, value: Buffer, type: number, valueLength: number, children: Buffer[] = []): Buffer {
  const header = Buffer.alloc(6), name = Buffer.from(`${key}\0`, "utf16le");
  const padding = (length: number) => Buffer.alloc((4 - length % 4) % 4);
  const head = Buffer.concat([header, name, padding(6 + name.length), value]);
  const chunks: Buffer[] = [head];
  let length = head.length;
  for (const child of children) { const pad = padding(length); chunks.push(pad, child); length += pad.length + child.length; }
  const result = Buffer.concat(chunks);
  result.writeUInt16LE(result.length, 0); result.writeUInt16LE(valueLength, 2); result.writeUInt16LE(type, 4);
  return result;
}

function versionInfo(name: string): Buffer {
  const fixed = Buffer.alloc(52);
  [0xfeef04bd, 0x10000, 1, 0, 1, 0, 0x3f, 0, 0x40004, 1, 0, 0, 0].forEach((value, index) => fixed.writeUInt32LE(value, index * 4));
  const strings = Object.entries({ ProductName: name, FileDescription: name, FileVersion: "0.1.0.0", ProductVersion: "0.1.0.0" })
    .map(([key, value]) => block(key, Buffer.from(`${value}\0`, "utf16le"), 1, value.length + 1));
  const stringInfo = block("StringFileInfo", Buffer.alloc(0), 1, 0, [block("040904B0", Buffer.alloc(0), 1, 0, strings)]);
  const translation = Buffer.from([0x09, 0x04, 0xb0, 0x04]);
  const varInfo = block("VarFileInfo", Buffer.alloc(0), 1, 0, [block("Translation", translation, 0, translation.length)]);
  return block("VS_VERSION_INFO", fixed, 0, fixed.length, [stringInfo, varInfo]);
}
