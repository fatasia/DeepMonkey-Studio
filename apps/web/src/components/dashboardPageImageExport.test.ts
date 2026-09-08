import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import { downloadDashboardPageImage, safeImageName } from "./dashboardPageImageExport";

const { toBlob } = vi.hoisted(() => ({ toBlob: vi.fn() }));
vi.mock("html-to-image", () => ({ toBlob }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); toBlob.mockReset(); });

function imageFixture() {
  const click = vi.fn(), remove = vi.fn(), revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
  const anchor = { click, remove, href: "", download: "" };
  vi.stubGlobal("document", { createElement: () => anchor, body: { append: vi.fn() } });
  vi.stubGlobal("window", { devicePixelRatio: 2, setTimeout: (callback: () => void) => callback() });
  vi.stubGlobal("getComputedStyle", () => ({ backgroundColor: "rgb(240, 244, 248)" }));
  const surface = { contains: vi.fn(() => true) } as unknown as HTMLElement;
  return { surface, artboard: {} as HTMLElement, page: { name: "生产", width: 1920, height: 1080 } as DashboardPageDocument, click, remove, create, revoke, anchor };
}

describe("dashboard PNG export", () => {
  it("uses the rendered background and design pixels regardless of device pixel ratio", async () => {
    const f = imageFixture();
    toBlob.mockResolvedValue(new Blob(["png"]));
    await downloadDashboardPageImage(f.surface, f.artboard, f.page, "zh-CN");
    expect(toBlob).toHaveBeenCalledWith(f.artboard, expect.objectContaining({ width: 1920, height: 1080, pixelRatio: 1, backgroundColor: "rgb(240, 244, 248)", style: expect.objectContaining({ transform: "none" }) }));
    expect(f.anchor.download).toBe("生产.png");
    expect(f.click).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith("blob:export");
  });
  it("does not encode an already cancelled request", async () => {
    const f = imageFixture(), controller = new AbortController();
    controller.abort();
    await expect(downloadDashboardPageImage(f.surface, f.artboard, f.page, "zh-CN", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(toBlob).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("discards a late encoded image after cancellation", async () => {
    const f = imageFixture(), controller = new AbortController();
    toBlob.mockImplementation(async () => { controller.abort(); return new Blob(["png"]); });
    await expect(downloadDashboardPageImage(f.surface, f.artboard, f.page, "zh-CN", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("does not download a replaced artboard or an empty encoding result", async () => {
    const f = imageFixture();
    toBlob.mockImplementation(async () => { vi.mocked(f.surface.contains).mockReturnValue(false); return new Blob(["png"]); });
    await expect(downloadDashboardPageImage(f.surface, f.artboard, f.page, "zh-CN")).rejects.toThrow("页面已切换");
    expect(f.create).not.toHaveBeenCalled();
    vi.mocked(f.surface.contains).mockReturnValue(true);
    toBlob.mockResolvedValue(null);
    await expect(downloadDashboardPageImage(f.surface, f.artboard, f.page, "zh-CN")).rejects.toThrow("图片编码失败");
  });
  it("reports resource failures without asserting that every network error is a cross-origin image", async () => {
    const f = imageFixture();
    toBlob.mockRejectedValue(new Error("Failed to fetch"));
    await expect(downloadDashboardPageImage(f.surface, f.artboard, f.page, "zh-CN")).rejects.toThrow("请检查网络与图片跨域权限");
    expect(f.click).not.toHaveBeenCalled();
  });
});

describe("safeImageName", () => {
  it("剥离文件系统非法字符并保留可读名", () => {
    expect(safeImageName('生产总览/报表<2026>:"v1"')).toBe("生产总览-报表-2026-v1-");
    expect(safeImageName("   ")).toBe("dashboard");
    expect(safeImageName("x".repeat(120))).toHaveLength(80);
  });

  it("结尾点号被去掉，避免 Windows 隐藏文件问题", () => {
    expect(safeImageName("季度报告...")).toBe("季度报告");
  });
});
