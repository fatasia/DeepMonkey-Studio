import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { assertClientIcon, parseClientPackageBranding } from "./clientPackageBranding.js";

describe("发布客户端品牌", () => {
  it("uses defaults for blank fields and preserves Chinese names", async () => {
    await expect(parseClientPackageBranding({ applicationName: "  ", iconDataUrl: "" })).resolves.toEqual({});
    await expect(parseClientPackageBranding({ applicationName: " 园区运行中心 " })).resolves.toEqual({ applicationName: "园区运行中心" });
  });
  it("creates six offline icon resolutions from a non-square transparent PNG", async () => {
    const png = await sharp({ create: { width: 80, height: 40, channels: 4, background: "#d6aa4d80" } }).png().toBuffer();
    const result = await parseClientPackageBranding({ iconDataUrl: `data:image/png;base64,${png.toString("base64")}` });
    const ico = Buffer.from(result.iconIco!);
    assertClientIcon(ico);
    expect(ico.readUInt16LE(4)).toBe(6);
    for (const [index, size] of [16, 24, 32, 48, 64, 256].entries()) {
      const entry = 6 + index * 16, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
      const metadata = await sharp(ico.subarray(offset, offset + length)).metadata();
      expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([size, size, true]);
    }
    const passThrough = await parseClientPackageBranding({ iconDataUrl: `data:image/x-icon;base64,${ico.toString("base64")}` });
    expect(passThrough.iconIco).toEqual(ico);
    const corrupt = Buffer.from(ico); corrupt.writeUInt32LE(0, 18);
    expect(() => assertClientIcon(corrupt)).toThrow("范围");
  });
  it.each([null, [], { path: "C:/outside.ico" }, { applicationName: "a\nb" }, { applicationName: "x".repeat(81) },
    { iconDataUrl: "https://example.com/icon.png" }, { iconDataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
    { iconDataUrl: "data:image/png;base64,AAAA" }, { iconDataUrl: "x".repeat(3 * 1024 ** 2) }])("rejects invalid branding", async input => {
    await expect(parseClientPackageBranding(input)).rejects.toThrow();
  });
  it("honors cancellation before decoding", async () => {
    await expect(parseClientPackageBranding({}, AbortSignal.abort())).rejects.toThrow();
  });
  it("accepts the existing product ICO and rejects directory-valid garbage pixels", async () => {
    const ico = await readFile(new URL("../../desktop/src-tauri/icons/icon.ico", import.meta.url));
    await expect(parseClientPackageBranding({ iconDataUrl: `data:image/x-icon;base64,${ico.toString("base64")}` })).resolves.toMatchObject({ iconIco: ico });
    const garbage = Buffer.alloc(30);
    garbage.writeUInt16LE(1, 2); garbage.writeUInt16LE(1, 4);
    garbage[6] = garbage[7] = 16;
    garbage.writeUInt32LE(8, 14); garbage.writeUInt32LE(22, 18);
    await expect(parseClientPackageBranding({ iconDataUrl: `data:image/x-icon;base64,${garbage.toString("base64")}` })).rejects.toThrow("图像数据");
  });
});
