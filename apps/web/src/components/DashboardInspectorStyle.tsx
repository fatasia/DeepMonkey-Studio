import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { DASHBOARD_COMPONENT_BACKGROUNDS, dashboardComponentBackgroundText } from "./DashboardComponentBackgroundCatalog";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardInspectorStyle() {
  const { applyComponentBackground, clearComponentBackground, componentBackgroundImageRef, inspectorTab, locale, selectedNode, updateDataWidget, uploadComponentBackground } =
    useDashboardWorkspace();
  if (!selectedNode) return null;

  return (
    inspectorTab === "style" &&
    selectedNode.kind === "data-widget" && (
      <section className="dashboard-inspector-section dashboard-data-widget-properties">
        <label>
          <span>{tr(locale, "强调色", "Accent")}</span>
          <input type="color" value={selectedNode.widget.color ?? "#d4a84f"} onChange={(event) => updateDataWidget({ color: event.target.value })} />
        </label>
        <label>
          <span>{tr(locale, "背景色", "Background")}</span>
          <input
            type="color"
            value={selectedNode.widget.backgroundColor ?? "#172126"}
            onChange={(event) =>
              updateDataWidget({
                backgroundColor: event.target.value,
              })
            }
          />
        </label>
        <label>
          <span>{tr(locale, "文字色", "Text color")}</span>
          <input type="color" value={selectedNode.widget.textColor ?? "#eef2f4"} onChange={(event) => updateDataWidget({ textColor: event.target.value })} />
        </label>
        {["text", "digital-flip"].includes(selectedNode.widget.type) && (
          <>
            <label>
              <span>{tr(locale, "字号", "Font size")}</span>
              <input
                type="number"
                min="8"
                max="240"
                value={selectedNode.widget.fontSize ?? (selectedNode.widget.type === "digital-flip" ? 38 : 28)}
                onChange={(event) =>
                  updateDataWidget({
                    fontSize: Number(event.target.value),
                  })
                }
              />
            </label>
            {selectedNode.widget.type === "text" && (
              <label>
                <span>{tr(locale, "对齐", "Alignment")}</span>
                <select
                  value={selectedNode.widget.textAlign ?? "left"}
                  onChange={(event) =>
                    updateDataWidget({
                      textAlign: event.target.value as NonNullable<DashboardDataWidgetConfig["textAlign"]>,
                    })
                  }
                >
                  <option value="left">{tr(locale, "左", "Left")}</option>
                  <option value="center">{tr(locale, "中", "Center")}</option>
                  <option value="right">{tr(locale, "右", "Right")}</option>
                </select>
              </label>
            )}
          </>
        )}
        {selectedNode.widget.type === "shape" && (
          <>
            <label>
              <span>{tr(locale, "边框色", "Border color")}</span>
              <input
                type="color"
                value={selectedNode.widget.borderColor ?? "#f0cd78"}
                onChange={(event) =>
                  updateDataWidget({
                    borderColor: event.target.value,
                  })
                }
              />
            </label>
            <label>
              <span>{tr(locale, "边框宽度", "Border width")}</span>
              <input
                type="number"
                min="0"
                max="24"
                value={selectedNode.widget.borderWidth ?? 1}
                onChange={(event) =>
                  updateDataWidget({
                    borderWidth: Number(event.target.value),
                  })
                }
              />
            </label>
          </>
        )}
        <label>
          <span>{tr(locale, "背景透明度", "Background opacity")}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={selectedNode.widget.backgroundOpacity ?? 0.86}
            onChange={(event) =>
              updateDataWidget({
                backgroundOpacity: Number(event.target.value),
              })
            }
          />
        </label>
        <div className="dashboard-component-background-editor">
          <span>{tr(locale, "组件背景图", "Component background image")}</span>
          <button onClick={() => componentBackgroundImageRef.current?.click()}>{selectedNode.widget.componentBackgroundImageName ?? tr(locale, "从本地上传", "Upload")}</button>
          {selectedNode.widget.componentBackgroundImageUrl && <button onClick={clearComponentBackground}>{tr(locale, "清除", "Clear")}</button>}
        </div>
        <details className="dashboard-component-background-library">
          <summary>
            {tr(locale, "内置组件背景", "Built-in component surfaces")}
            <small>{DASHBOARD_COMPONENT_BACKGROUNDS.length}</small>
          </summary>
          <div>
            {DASHBOARD_COMPONENT_BACKGROUNDS.map((asset) => (
              <button
                key={asset.id}
                className={selectedNode.widget.componentBackgroundImageUrl === asset.url ? "active" : ""}
                title={`${dashboardComponentBackgroundText(asset, locale)} · ${asset.tags.join(" / ")}`}
                onClick={() => applyComponentBackground(asset)}
              >
                <i
                  style={{
                    backgroundImage: `url(${JSON.stringify(asset.url)})`,
                  }}
                />
                <span>{dashboardComponentBackgroundText(asset, locale)}</span>
              </button>
            ))}
          </div>
        </details>
        {selectedNode.widget.componentBackgroundImageUrl && (
          <>
            <label>
              <span>{tr(locale, "背景图填充", "Background fit")}</span>
              <select
                value={selectedNode.widget.componentBackgroundImageFit ?? "cover"}
                onChange={(event) =>
                  updateDataWidget({
                    componentBackgroundImageFit: event.target.value as NonNullable<DashboardDataWidgetConfig["componentBackgroundImageFit"]>,
                  })
                }
              >
                <option value="cover">{tr(locale, "覆盖组件", "Cover")}</option>
                <option value="contain">{tr(locale, "完整显示", "Contain")}</option>
                <option value="stretch">{tr(locale, "拉伸", "Stretch")}</option>
                <option value="original">{tr(locale, "原始尺寸", "Original")}</option>
              </select>
            </label>
            <label>
              <span>{tr(locale, "背景图位置", "Background position")}</span>
              <select
                value={selectedNode.widget.componentBackgroundImagePosition ?? "center"}
                onChange={(event) =>
                  updateDataWidget({
                    componentBackgroundImagePosition: event.target.value as NonNullable<DashboardDataWidgetConfig["componentBackgroundImagePosition"]>,
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
                checked={selectedNode.widget.componentBackgroundImageRepeat ?? false}
                onChange={(event) =>
                  updateDataWidget({
                    componentBackgroundImageRepeat: event.target.checked,
                  })
                }
              />
              {tr(locale, "平铺组件背景", "Tile component background")}
            </label>
          </>
        )}
        <input
          ref={componentBackgroundImageRef}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          onChange={(event) => void uploadComponentBackground(event.target.files?.[0])}
        />
      </section>
    )
  );
}
