export type AppLocale = "zh-CN" | "en-US";

export function translate(locale: AppLocale, chinese: string, english: string): string {
  return locale === "en-US" ? english : chinese;
}

export function readLocale(): AppLocale {
  return window.localStorage.getItem("bim-studio.locale") === "en-US" ? "en-US" : "zh-CN";
}

export function storeLocale(locale: AppLocale): void {
  window.localStorage.setItem("bim-studio.locale", locale);
  document.documentElement.lang = locale;
}
