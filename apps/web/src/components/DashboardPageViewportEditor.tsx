import {
  DASHBOARD_PAGE_MAX_SIZE,
  DASHBOARD_PAGE_MIN_SIZE,
  type DashboardPageDocument,
  type DashboardViewportFit,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DASHBOARD_RESOLUTION_PRESETS } from "./dashboardWorkspaceModel";

export function DashboardPageViewportEditor({
  locale,
  page,
  onChange,
  compact = false,
}: {
  locale: AppLocale;
  page: DashboardPageDocument;
  onChange: (viewport: {
    width?: number;
    height?: number;
    viewportFit?: DashboardViewportFit;
  }) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`dashboard-page-viewport-editor ${compact ? "compact" : ""}`}
    >
      <label>
        <span>{tr(locale, "逻辑分辨率", "Logical resolution")}</span>
        <select
          value={dashboardResolutionPreset(page)}
          onChange={(event) => {
            const preset = DASHBOARD_RESOLUTION_PRESETS.find(
              (candidate) => candidate.id === event.target.value,
            );
            if (preset)
              onChange({ width: preset.width, height: preset.height });
          }}
        >
          <option value="custom">{tr(locale, "自定义", "Custom")}</option>
          {DASHBOARD_RESOLUTION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <div className="dashboard-frame-grid dashboard-resolution-grid">
        <label>
          <span>W</span>
          <input
            key={`${page.id}:width:${page.width}`}
            aria-label={tr(locale, "页面宽度", "Page width")}
            type="number"
            min={DASHBOARD_PAGE_MIN_SIZE}
            max={DASHBOARD_PAGE_MAX_SIZE}
            defaultValue={page.width}
            onBlur={(event) =>
              onChange({ width: Number(event.currentTarget.value) })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label>
          <span>H</span>
          <input
            key={`${page.id}:height:${page.height}`}
            aria-label={tr(locale, "页面高度", "Page height")}
            type="number"
            min={DASHBOARD_PAGE_MIN_SIZE}
            max={DASHBOARD_PAGE_MAX_SIZE}
            defaultValue={page.height}
            onBlur={(event) =>
              onChange({ height: Number(event.currentTarget.value) })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
      </div>
      <label>
        <span>{tr(locale, "屏幕适配", "Display fit")}</span>
        <select
          value={page.viewportFit}
          onChange={(event) =>
            onChange({
              viewportFit: event.target.value as DashboardViewportFit,
            })
          }
        >
          <option value="contain">
            {tr(locale, "完整显示（推荐）", "Contain (recommended)")}
          </option>
          <option value="cover">
            {tr(locale, "铺满并裁切", "Cover and crop")}
          </option>
          <option value="stretch">
            {tr(locale, "拉伸铺满", "Stretch to fill")}
          </option>
          <option value="fixed">
            {tr(locale, "原始像素 / 滚动", "Fixed pixels / scroll")}
          </option>
        </select>
      </label>
    </div>
  );
}

function dashboardResolutionPreset(page: DashboardPageDocument): string {
  return (
    DASHBOARD_RESOLUTION_PRESETS.find(
      (preset) => preset.width === page.width && preset.height === page.height,
    )?.id ?? "custom"
  );
}
