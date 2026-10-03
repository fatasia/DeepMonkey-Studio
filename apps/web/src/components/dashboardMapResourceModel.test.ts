import { describe, expect, it } from "vitest";
import {
  dashboardMapGeoJsonPlaceholderMessage,
  resolveDashboardMapGeoJsonState,
} from "./dashboardMapResourceModel";

describe("dashboard map external resource state", () => {
  it("maps the four exclusive GeoJSON load states", () => {
    expect(resolveDashboardMapGeoJsonState({ url: undefined, loaded: false, failed: false })).toBe("empty");
    expect(resolveDashboardMapGeoJsonState({ url: "/assets/maps/china.json", loaded: false, failed: false })).toBe("loading");
    expect(resolveDashboardMapGeoJsonState({ url: "/assets/maps/china.json", loaded: false, failed: true })).toBe("error");
    expect(resolveDashboardMapGeoJsonState({ url: "/assets/maps/china.json", loaded: true, failed: false })).toBe("ready");
  });

  it("reports failures with an actionable message instead of faking a load-in-progress", () => {
    const error = dashboardMapGeoJsonPlaceholderMessage("error", "zh-CN");
    expect(error).toContain("加载失败");
    expect(error).toContain("重试");
    expect(error).not.toContain("加载中");
    expect(dashboardMapGeoJsonPlaceholderMessage("loading", "zh-CN")).toBe("GeoJSON 加载中…");
    expect(dashboardMapGeoJsonPlaceholderMessage("loading", "en-US")).toBe("Loading GeoJSON…");
    expect(dashboardMapGeoJsonPlaceholderMessage("empty", "en-US")).toBe("Configure GeoJSON");
  });
});
