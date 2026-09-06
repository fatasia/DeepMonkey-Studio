import type { SystemBrandingSettings } from "@bim-studio/contracts";

/** 同步浏览器页签、主题色和 favicon；主应用与独立发布浏览器共用同一规则。 */
export function applyDocumentBranding(
  branding: Pick<SystemBrandingSettings, "browserTitle" | "iconUrl" | "primaryColor" | "themeMode">,
): void {
  document.title = branding.browserTitle;
  document.documentElement.style.setProperty("--accent", branding.primaryColor);
  document.documentElement.style.setProperty("--on-accent", accentForeground(branding.primaryColor));
  document.documentElement.dataset.theme = branding.themeMode;
  document.documentElement.style.colorScheme = branding.themeMode;
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.append(icon);
  }
  icon.href = branding.iconUrl;
}

/** 只选择 base.css 定义的中性文字令牌；选择对比更高的一端，不另造品牌调色板。 */
export function accentForeground(color: string): string {
  const hex = color.trim().replace(/^#([\da-f])([\da-f])([\da-f])$/i, "#$1$1$2$2$3$3");
  if (!/^#[\da-f]{6}$/i.test(hex)) return "var(--on-accent-dark)";
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const luminance = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "var(--on-accent-dark)" : "var(--on-accent-light)";
}
