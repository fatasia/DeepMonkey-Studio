import type { SystemBrandingSettings } from "@bim-studio/contracts";

/** 同步浏览器页签、主题色和 favicon；主应用与独立发布浏览器共用同一规则。 */
export function applyDocumentBranding(
  branding: Pick<SystemBrandingSettings, "browserTitle" | "iconUrl" | "primaryColor" | "themeMode">,
): void {
  document.title = branding.browserTitle;
  document.documentElement.style.setProperty("--accent", branding.primaryColor);
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
