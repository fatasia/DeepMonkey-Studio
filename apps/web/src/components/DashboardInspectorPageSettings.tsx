import type { DashboardPageAppearance } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { DashboardPageViewportEditor } from "./DashboardPageViewportEditor";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

/** 页面级属性与组件级属性分离，避免用户选中组件后误改整个画布。 */
export function DashboardInspectorPageSettings() {
  const { backgroundImageRef, clearPageBackground, commitPageName, commitPageViewport, locale, page, updatePageAppearance, uploadPageBackground } = useDashboardWorkspace();

  return (
    <section className="dashboard-inspector-section">
      <label>
        <span>{tr(locale, "页面名称", "Page name")}</span>
        <input
          defaultValue={page.name}
          key={`${page.id}:${page.name}`}
          onBlur={(event) => commitPageName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      <DashboardPageViewportEditor locale={locale} page={page} onChange={commitPageViewport} />
      <div className="dashboard-page-background-editor">
        <label>
          <span>{tr(locale, "画布背景色", "Canvas background")}</span>
          <input type="color" value={page.appearance?.backgroundColor ?? "#12191d"} onChange={(event) => updatePageAppearance({ backgroundColor: event.target.value })} />
        </label>
        <div>
          <span>{tr(locale, "背景图片", "Background image")}</span>
          <button onClick={() => backgroundImageRef.current?.click()}>{page.appearance?.backgroundImageName ?? tr(locale, "上传图片", "Upload image")}</button>
          {page.appearance?.backgroundImageUrl && <button onClick={clearPageBackground}>{tr(locale, "清除", "Clear")}</button>}
        </div>
        {page.appearance?.backgroundImageUrl && (
          <>
            <label>
              <span>{tr(locale, "填充方式", "Image fit")}</span>
              <select
                value={page.appearance.backgroundImageFit ?? "cover"}
                onChange={(event) =>
                  updatePageAppearance({
                    backgroundImageFit: event.target.value as NonNullable<DashboardPageAppearance["backgroundImageFit"]>,
                  })
                }
              >
                <option value="cover">{tr(locale, "覆盖画布", "Cover")}</option>
                <option value="contain">{tr(locale, "完整显示", "Contain")}</option>
                <option value="stretch">{tr(locale, "拉伸", "Stretch")}</option>
                <option value="original">{tr(locale, "原始尺寸", "Original")}</option>
              </select>
            </label>
            <label>
              <span>{tr(locale, "对齐位置", "Position")}</span>
              <select
                value={page.appearance.backgroundImagePosition ?? "center"}
                onChange={(event) =>
                  updatePageAppearance({
                    backgroundImagePosition: event.target.value as NonNullable<DashboardPageAppearance["backgroundImagePosition"]>,
                  })
                }
              >
                <option value="center">{tr(locale, "居中", "Center")}</option>
                <option value="top">{tr(locale, "顶部", "Top")}</option>
                <option value="bottom">{tr(locale, "底部", "Bottom")}</option>
                <option value="left">{tr(locale, "左侧", "Left")}</option>
                <option value="right">{tr(locale, "右侧", "Right")}</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={page.appearance.backgroundImageRepeat ?? false}
                onChange={(event) => updatePageAppearance({ backgroundImageRepeat: event.target.checked })}
              />
              {tr(locale, "平铺背景", "Tile image")}
            </label>
          </>
        )}
        <input
          ref={backgroundImageRef}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          onChange={(event) => void uploadPageBackground(event.target.files?.[0])}
        />
      </div>
    </section>
  );
}
