import { translate as tr, type AppLocale } from "../i18n";

export type DashboardMapGeoJsonState = "empty" | "loading" | "error" | "ready";
export type DashboardMapGeoJsonPlaceholderState = Exclude<DashboardMapGeoJsonState, "ready">;

/**
 * 外部 GeoJSON 资源的四态。加载失败必须落在 error，
 * 禁止退回 loading 伪装（那会让用户把故障当慢网络无限等待）。
 */
export function resolveDashboardMapGeoJsonState(input: {
  url: string | undefined;
  loaded: boolean;
  failed: boolean;
}): DashboardMapGeoJsonState {
  if (!input.url) return "empty";
  if (input.loaded) return "ready";
  return input.failed ? "error" : "loading";
}

export function dashboardMapGeoJsonPlaceholderMessage(
  state: DashboardMapGeoJsonPlaceholderState,
  locale: AppLocale,
): string {
  if (state === "error") {
    return tr(locale, "GeoJSON 加载失败，请检查地址或网络后重试", "GeoJSON failed to load; check the URL or network and retry");
  }
  if (state === "loading") return tr(locale, "GeoJSON 加载中…", "Loading GeoJSON…");
  return tr(locale, "请配置 GeoJSON", "Configure GeoJSON");
}
