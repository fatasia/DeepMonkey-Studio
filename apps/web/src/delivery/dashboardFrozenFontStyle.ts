/** Read the OS/2 style of one static sfnt face; never guess font weight or synthesize it. */
export function dashboardFrozenFontStyle(bytes: Uint8Array): { weight: number; style: "normal" | "italic" } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ![0x00010000, 0x4f54544f].includes(view.getUint32(0)))
    throw new Error("Heading layout requires an individual static OpenType font");
  const count = view.getUint16(4);
  if (12 + count * 16 > bytes.length) throw new Error("Truncated frozen font directory");
  let os2 = -1;
  for (let index = 0; index < count; index++) {
    const entry = 12 + index * 16, tag = view.getUint32(entry);
    const offset = view.getUint32(entry + 8), length = view.getUint32(entry + 12);
    if (offset + length > bytes.length) throw new Error("Truncated frozen font table");
    if (tag === 0x66766172) throw new Error("Variable font coordinates require an explicit capture contract");
    if (tag === 0x4f532f32 && length >= 64) os2 = offset;
  }
  if (os2 < 0) throw new Error("Frozen font has no OS/2 style identity");
  const weight = view.getUint16(os2 + 4), selection = view.getUint16(os2 + 62);
  if (weight < 1 || weight > 1000 || selection & 512) throw new Error("Unsupported frozen font style");
  return { weight, style: selection & 1 ? "italic" : "normal" };
}
