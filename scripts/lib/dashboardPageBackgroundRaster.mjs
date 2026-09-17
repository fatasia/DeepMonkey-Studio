import sharp from "sharp";

const MAX_PIXELS = 16 * 1024 * 1024;
const positions = { center: "centre", top: "north", bottom: "south", left: "west", right: "east" };
export async function decodePageBackgroundPixels(request, signal) {
  const layout = request.background;
  if (!layout || !["cover", "contain", "stretch", "original"].includes(layout.fit)
    || !Object.hasOwn(positions, layout.position) || typeof layout.repeat !== "boolean")
    throw new Error("Invalid frozen page background layout");
  const options = { limitInputPixels: MAX_PIXELS, failOn: "warning" };
  const metadata = await sharp(request.asset.bytes, options).metadata();
  if ((metadata.pages ?? 1) !== 1) throw new Error("Animated/multipage images require a separate producer");
  signal?.throwIfAborted();
  let pipeline = sharp(request.asset.bytes, options).rotate();
  if (layout.fit !== "original") pipeline = pipeline.resize(request.width, request.height, {
    fit: layout.fit === "stretch" ? "fill" : layout.fit === "contain" ? "inside" : "cover",
    position: positions[layout.position],
  });
  const { data, info } = await pipeline.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();
  if (info.channels !== 4 || info.width * info.height > MAX_PIXELS)
    throw new Error("Page background decoded pixel budget exceeded");
  const offset = (space, edge, low, high) => edge === low ? 0 : edge === high ? space : Math.floor(space / 2);
  const left = offset(request.width - info.width, layout.position, "left", "right");
  const top = offset(request.height - info.height, layout.position, "top", "bottom");
  const output = Buffer.alloc(request.width * request.height * 4);
  // 按行段复制平铺图，避免为小图创建与画布像素数同量级的 composite 对象。
  for (let y = 0; y < request.height; y++) {
    signal?.throwIfAborted();
    if (layout.repeat && y >= info.height) {
      output.copy(output, y * request.width * 4, (y - info.height) * request.width * 4,
        (y - info.height + 1) * request.width * 4);
      continue;
    }
    let sourceY = y - top;
    if (layout.repeat) sourceY = ((sourceY % info.height) + info.height) % info.height;
    else if (sourceY < 0 || sourceY >= info.height) continue;
    for (let x = 0; x < request.width;) {
      let sourceX = x - left;
      if (layout.repeat) sourceX = ((sourceX % info.width) + info.width) % info.width;
      else if (sourceX < 0) { x = Math.min(left, request.width); continue; }
      else if (sourceX >= info.width) break;
      const length = Math.min(info.width - sourceX, request.width - x,
        layout.repeat ? info.width - x : Infinity);
      const source = (sourceY * info.width + sourceX) * 4;
      data.copy(output, (y * request.width + x) * 4, source, source + length * 4);
      x += length;
      if (layout.repeat && x >= info.width) {
        const row = y * request.width * 4;
        while (x < request.width) {
          const copy = Math.min(x, request.width - x);
          output.copy(output, row + x * 4, row, row + copy * 4);
          x += copy;
        }
      }
    }
  }
  return output;
}
