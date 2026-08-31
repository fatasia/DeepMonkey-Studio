import { Box, Workflow } from "lucide-react";
import type { DashboardDataWidgetConfig, SceneDashboardWidgetType } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { DashboardMediaInspector } from "./DashboardMediaInspector";
import { UnityResourceInspector } from "./UnityResourceInspector";
import { DATA_WIDGET_TYPES, DECORATION_ASSETS, dashboardNodeIdentity as nodeIdentity, dataWidgetTypeLabel } from "./dashboardWorkspaceModel";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardInspectorContent() {
  const {
    application,
    commitNodeName,
    currentView,
    inspectorTab,
    locale,
    nodeNameError,
    onEnterScene,
    onOpenTopology,
    project,
    reorderSelectedNodes,
    selectedNode,
    setNodeNameError,
    updateDataWidget,
    updateSceneViewport,
    updateSelectedFrame,
  } = useDashboardWorkspace();
  if (!selectedNode) return null;

  return (
    inspectorTab === "content" && (
      <>
        <section className="dashboard-inspector-section">
          <label>
            <span>{tr(locale, "组件名称（页面内唯一）", "Component name (unique on page)")}</span>
            <input
              key={`${selectedNode.id}:name:${selectedNode.name ?? ""}`}
              defaultValue={nodeIdentity(selectedNode)}
              onFocus={() => setNodeNameError("")}
              onBlur={(event) => commitNodeName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            {nodeNameError && <small className="dashboard-field-error">{nodeNameError}</small>}
          </label>
          <div className="dashboard-frame-grid">
            {(["x", "y", "width", "height"] as const).map((field) => (
              <label key={field}>
                <span>
                  {
                    {
                      x: "X",
                      y: "Y",
                      width: tr(locale, "宽", "W"),
                      height: tr(locale, "高", "H"),
                    }[field]
                  }
                </span>
                <input
                  type="number"
                  disabled={selectedNode.locked === true}
                  value={selectedNode.frame[field]}
                  onChange={(event) => updateSelectedFrame(field, Number(event.target.value))}
                />
              </label>
            ))}
          </div>
          <div className="dashboard-layer-order-actions">
            <button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("back")}>
              {tr(locale, "置底", "To back")}
            </button>
            <button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("backward")}>
              {tr(locale, "下移", "Backward")}
            </button>
            <button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("forward")}>
              {tr(locale, "上移", "Forward")}
            </button>
            <button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("front")}>
              {tr(locale, "置顶", "To front")}
            </button>
          </div>
        </section>
        {selectedNode.kind === "scene-viewport" && (
          <section className="dashboard-inspector-section dashboard-data-widget-properties">
            <label>
              <span>{tr(locale, "三维场景", "3D scene")}</span>
              <select value={selectedNode.sceneId} onChange={(event) => updateSceneViewport({ sceneId: event.target.value })}>
                {application.scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{tr(locale, "渲染方式", "Render mode")}</span>
              <select
                value={selectedNode.renderMode}
                onChange={(event) =>
                  updateSceneViewport({
                    renderMode: event.target.value as typeof selectedNode.renderMode,
                  })
                }
              >
                <option value="realtime">{tr(locale, "实时渲染", "Realtime")}</option>
                <option value="load-on-interaction">{tr(locale, "交互时加载", "Load on interaction")}</option>
                <option value="static-placeholder">{tr(locale, "静态占位", "Static placeholder")}</option>
              </select>
            </label>
            <label>
              <span>{tr(locale, "交互权限", "Interaction")}</span>
              <select
                value={selectedNode.interactionPolicy}
                onChange={(event) =>
                  updateSceneViewport({
                    interactionPolicy: event.target.value as typeof selectedNode.interactionPolicy,
                  })
                }
              >
                <option value="full-navigation">{tr(locale, "完整漫游", "Full navigation")}</option>
                <option value="click-select">{tr(locale, "仅点击选取", "Click select")}</option>
                <option value="display-only">{tr(locale, "仅展示", "Display only")}</option>
              </select>
            </label>
            <button className="dashboard-enter-scene" onClick={() => onEnterScene(selectedNode.sceneId, currentView())}>
              <Box size={15} />
              {tr(locale, "进入三维编辑", "Open 3D editor")}
            </button>
          </section>
        )}
        {selectedNode.kind === "data-widget" && (
          <section className="dashboard-inspector-section dashboard-data-widget-properties">
            <label>
              <span>{tr(locale, "类型", "Type")}</span>
              <select
                value={selectedNode.widget.type}
                onChange={(event) =>
                  updateDataWidget({
                    type: event.target.value as SceneDashboardWidgetType,
                  })
                }
              >
                {DATA_WIDGET_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {dataWidgetTypeLabel(locale, type)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{tr(locale, "标题", "Title")}</span>
              <input
                defaultValue={selectedNode.widget.title}
                key={`${selectedNode.id}:title:${selectedNode.widget.title}`}
                onBlur={(event) => {
                  if (event.currentTarget.value !== selectedNode.widget.title)
                    updateDataWidget({
                      title: event.currentTarget.value,
                    });
                }}
              />
            </label>
            {(selectedNode.widget.type === "text" || selectedNode.widget.type === "shape" || selectedNode.widget.type === "decoration") && (
              <label>
                <span>{tr(locale, "内容", "Content")}</span>
                <input
                  defaultValue={selectedNode.widget.content ?? ""}
                  onBlur={(event) =>
                    updateDataWidget({
                      content: event.currentTarget.value,
                    })
                  }
                />
              </label>
            )}
            {selectedNode.widget.type === "shape" && (
              <label>
                <span>{tr(locale, "形状", "Shape")}</span>
                <select
                  value={selectedNode.widget.shape ?? "rounded"}
                  onChange={(event) =>
                    updateDataWidget({
                      shape: event.target.value as NonNullable<DashboardDataWidgetConfig["shape"]>,
                    })
                  }
                >
                  <option value="rectangle">{tr(locale, "矩形", "Rectangle")}</option>
                  <option value="rounded">{tr(locale, "圆角矩形", "Rounded")}</option>
                  <option value="ellipse">{tr(locale, "椭圆", "Ellipse")}</option>
                  <option value="line">{tr(locale, "线", "Line")}</option>
                </select>
              </label>
            )}
            {selectedNode.widget.type === "decoration" && (
              <label>
                <span>{tr(locale, "装饰样式", "Decoration style")}</span>
                <select
                  value={selectedNode.widget.decorationStyle ?? "title"}
                  onChange={(event) =>
                    updateDataWidget({
                      decorationStyle: event.target.value as NonNullable<DashboardDataWidgetConfig["decorationStyle"]>,
                    })
                  }
                >
                  {DECORATION_ASSETS.map((asset) => (
                    <option key={asset.style} value={asset.style}>
                      {tr(locale, asset.zh, asset.en)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selectedNode.widget.type === "filter" && (
              <>
                <label>
                  <span>{tr(locale, "筛选控件", "Filter control")}</span>
                  <select
                    value={selectedNode.widget.filterMode ?? "select"}
                    onChange={(event) =>
                      updateDataWidget({
                        filterMode: event.target.value as NonNullable<DashboardDataWidgetConfig["filterMode"]>,
                      })
                    }
                  >
                    <option value="select">{tr(locale, "单选下拉", "Single select")}</option>
                    <option value="multi-select">{tr(locale, "多选列表", "Multi select")}</option>
                    <option value="text">{tr(locale, "文本搜索", "Text search")}</option>
                    <option value="date">{tr(locale, "日期", "Date")}</option>
                  </select>
                </label>
                {!["text", "date"].includes(selectedNode.widget.filterMode ?? "select") && (
                  <label>
                    <span>{tr(locale, "选项（逗号分隔）", "Options (comma separated)")}</span>
                    <input
                      defaultValue={(selectedNode.widget.options ?? []).join(", ")}
                      onBlur={(event) =>
                        updateDataWidget({
                          options: event.currentTarget.value
                            .split(/[,，]/)
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                )}
                <label>
                  <span>{tr(locale, "绑定参数", "Bound parameter")}</span>
                  <input value={selectedNode.widget.key} onChange={(event) => updateDataWidget({ key: event.target.value })} />
                  <small>
                    {tr(
                      locale,
                      "参数在所有二维页面共享，修改后自动刷新绑定的数据组件。",
                      "The parameter is shared across all dashboard pages and refreshes bound data widgets automatically.",
                    )}
                  </small>
                </label>
                <label>
                  <span>{tr(locale, "过滤字段", "Filter field")}</span>
                  <input
                    value={selectedNode.widget.filterField ?? ""}
                    placeholder={selectedNode.widget.key}
                    onChange={(event) =>
                      updateDataWidget({
                        filterField: event.target.value,
                      })
                    }
                  />
                </label>
                {selectedNode.widget.filterMode === "text" && (
                  <label>
                    <span>{tr(locale, "匹配方式", "Match mode")}</span>
                    <select
                      value={selectedNode.widget.filterMatch ?? "contains"}
                      onChange={(event) =>
                        updateDataWidget({
                          filterMatch: event.target.value as NonNullable<DashboardDataWidgetConfig["filterMatch"]>,
                        })
                      }
                    >
                      <option value="contains">{tr(locale, "包含", "Contains")}</option>
                      <option value="exact">{tr(locale, "完全匹配", "Exact")}</option>
                    </select>
                  </label>
                )}
                <label>
                  <span>{tr(locale, "上级参数（可选）", "Parent parameter (optional)")}</span>
                  <input
                    value={selectedNode.widget.parentFilterKey ?? ""}
                    onChange={(event) =>
                      updateDataWidget({
                        parentFilterKey: event.target.value,
                      })
                    }
                  />
                  <small>{tr(locale, "存在上级参数时，未选择上级条件前此控件保持禁用。", "When configured, this control remains disabled until its parent has a value.")}</small>
                </label>
              </>
            )}
            {(selectedNode.widget.type === "image" || selectedNode.widget.type === "video" || selectedNode.widget.type === "monitor") && (
              <DashboardMediaInspector locale={locale} projectId={project.id} widget={selectedNode.widget} onChange={updateDataWidget} />
            )}
            {selectedNode.widget.type === "url" && (
              <label>
                <span>{tr(locale, "网页地址", "Web page URL")}</span>
                <input defaultValue={selectedNode.widget.url ?? ""} onBlur={(event) => updateDataWidget({ url: event.currentTarget.value })} />
              </label>
            )}
            {selectedNode.widget.type === "unity" && (
              <UnityResourceInspector locale={locale} projectId={project.id} widgetId={selectedNode.id} widget={selectedNode.widget} onChange={updateDataWidget} />
            )}
            {selectedNode.widget.type === "topology" && (
              <>
                <label>
                  <span>{tr(locale, "拓扑文档", "Topology document")}</span>
                  <select
                    value={selectedNode.widget.topologyId ?? ""}
                    onChange={(event) =>
                      updateDataWidget({
                        topologyId: event.target.value,
                      })
                    }
                  >
                    <option value="">{tr(locale, "选择拓扑", "Choose topology")}</option>
                    {application.topologies.map((topology) => (
                      <option key={topology.id} value={topology.id}>
                        {topology.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="dashboard-enter-scene" disabled={!selectedNode.widget.topologyId} onClick={onOpenTopology}>
                  <Workflow size={15} />
                  {tr(locale, "编辑当前拓扑", "Edit topology")}
                </button>
              </>
            )}
          </section>
        )}
      </>
    )
  );
}
