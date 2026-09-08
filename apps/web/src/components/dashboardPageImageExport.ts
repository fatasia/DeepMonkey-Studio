import type { DashboardPageDocument } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

/**
 * 运行页 PNG 导出：html-to-image 处理 canvas 快照、字体与样式内联，
 * 以页面设计分辨率（非窗口缩放）光栅化，匿名页与作者预览同链路。
 */
export async function downloadDashboardPageImage(
  surface: HTMLElement,
  artboard: HTMLElement,
  page: DashboardPageDocument,
  locale: AppLocale,
  signal?: AbortSignal,
): Promise<void> {
  try {
    signal?.throwIfAborted();
    const { toBlob } = await import("html-to-image");
    signal?.throwIfAborted();
    if (!surface.contains(artboard)) throw new Error(tr(locale, "页面已切换，请重新导出", "The page changed. Export again."));
    const backgroundColor = getComputedStyle(artboard).backgroundColor;
    const blob = await toBlob(artboard, {
      width: page.width,
      height: page.height,
      pixelRatio: 1,
      backgroundColor,
      // 画布本身带 transform:scale 适配窗口；导出按设计分辨率重置，避免截到缩放留白。
      style: { transform: "none", left: "0px", top: "0px", margin: "0px" },
    });
    signal?.throwIfAborted();
    if (!surface.contains(artboard)) throw new Error(tr(locale, "页面已切换，请重新导出", "The page changed. Export again."));
    if (!blob) throw new Error(tr(locale, "图片编码失败，请重试", "PNG encoding failed. Retry."));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeImageName(page.name)}.png`;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  } catch (reason) {
    signal?.throwIfAborted();
    if (reason instanceof Error && /Failed to fetch|NetworkError|SecurityError|tainted/i.test(reason.message)) {
      throw new Error(tr(locale, "资源读取失败，无法导出图片；请检查网络与图片跨域权限后重试", "Resources could not be read. Check the network and image cross-origin permissions, then retry."));
    }
    throw reason instanceof Error ? reason : new Error(tr(locale, "图片导出失败，请重试", "Image export failed. Retry."));
  }
}

export function safeImageName(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\.+$/g, "").slice(0, 80);
  return safe || "dashboard";
}
