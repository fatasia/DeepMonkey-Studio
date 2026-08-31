import type { CSSProperties } from "react";
import {
  AlertTriangle,
  Box,
  Check,
  CircleDot,
  CloudUpload,
  Copy,
  Database,
  Gauge,
  Layers3,
  LayoutGrid,
  LayoutDashboard,
  Link2,
  MousePointer2,
  Plus,
  Redo2,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  WifiOff,
  Workflow,
  ZoomIn,
  ZoomOut,
  X,
} from "lucide-react";
import {
  assessTopologyScadaRuntime,
  canRedoTopologyEdit,
  canUndoTopologyEdit,
  isTopologyScadaNode,
  topologyNodeDataBinding,
  topologyNodeLabel,
  topologyNodeScadaConfig,
  type TopologyScadaNodeConfig,
} from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { InspectorNumberField, InspectorOptionalNumberField, InspectorTextField } from "./TopologyInspectorFields";
import {
  ScadaRuntimeCard,
  formatScadaValue,
  qualityLabel,
  runtimeAssessmentLabel,
  scadaStateLabel,
  topologyEdgeAnimated,
  topologyEdgeLabel,
  topologyEdgeMedium,
  topologyEdgeStateClass,
  topologyNodeElevation,
  topologyProjectedPosition,
} from "./topologyEditorRuntime";
import type { TopologyEditorController } from "./TopologyEditorPanel";

export function TopologyEditorPanelView({ controller }: { controller: TopologyEditorController }) {
  const {
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    GRID_SIZE,
    NODE_HEIGHT,
    NODE_PRESETS,
    NODE_WIDTH,
    acknowledgeAlarm,
    acknowledgePendingNodeId,
    activeAlarms,
    addNode,
    alignSelection,
    autoLayout,
    autoSaveEnabled,
    beginDrag,
    binding,
    busy,
    canvasRef,
    connectionSourceId,
    dataProducts,
    dirty,
    dispatch,
    document,
    drag,
    dragPosition,
    duplicateSelection,
    edgeGeometry,
    editor,
    endDrag,
    handleKeyboard,
    locale,
    markerId,
    moveDrag,
    nodeName,
    onAcknowledgeAlarm,
    onAutoSaveChange,
    onChange,
    onClose,
    onInsertDashboard,
    onPublish,
    onSave,
    operationError,
    paletteQuery,
    presetGroups,
    removeSelection,
    runtimeNowMs,
    runtimeStaleAfterMs,
    runtimeStates,
    runtimeSummary,
    scadaConfig,
    selectNode,
    selectTool,
    selectedEdge,
    selectedNode,
    selectedProduct,
    selectedRuntimeAssessment,
    selectedRuntimeState,
    selectedNodeIds,
    selection,
    setBindingProduct,
    setOperationError,
    setPaletteQuery,
    setViewMode,
    tool,
    updateEdgeProperties,
    updateScadaConfig,
    updateScadaThreshold,
    viewMode,
    zoom,
    zoomIn,
    zoomOut,
    resetZoom,
  } = controller;

  return (
    <section className="topology-editor" tabIndex={0} onKeyDown={handleKeyboard} aria-label={tr(locale, "拓扑编辑器", "Topology editor")}>
      <header className="topology-editor__header">
        <div className="topology-editor__title">
          <span className="topology-editor__mark">
            <Workflow size={18} />
          </span>
          <span>
            <strong>{editor.document.name}</strong>
            <small>{tr(locale, "独立拓扑 · 数据驱动", "Topology · Data driven")}</small>
          </span>
        </div>
        <div className="topology-editor__tools" role="toolbar" aria-label={tr(locale, "编辑工具", "Editor tools")}>
          <button className={tool === "select" ? "is-active" : ""} onClick={() => selectTool("select")} title={tr(locale, "选择 (V)", "Select (V)")}>
            <MousePointer2 size={15} />
          </button>
          <button className={tool === "connect" ? "is-active" : ""} onClick={() => selectTool("connect")} title={tr(locale, "创建连线", "Connect nodes")}>
            <Link2 size={15} />
          </button>
          <button onClick={autoLayout} disabled={editor.document.nodes.length < 2} title={tr(locale, "自动分层布局", "Auto layout")}>
            <LayoutGrid size={15} />
          </button>
          <button onClick={duplicateSelection} disabled={selectedNodeIds.length === 0} title={tr(locale, "复制所选 Ctrl+D", "Duplicate Ctrl+D")}>
            <Copy size={15} />
          </button>
          {selectedNodeIds.length > 1 && (
            <>
              <button onClick={() => alignSelection("left")} title={tr(locale, "左对齐", "Align left")}>左</button>
              <button onClick={() => alignSelection("top")} title={tr(locale, "顶对齐", "Align top")}>顶</button>
              <button disabled={selectedNodeIds.length < 3} onClick={() => alignSelection("distribute-horizontal")} title={tr(locale, "水平等距", "Distribute horizontally")}>距</button>
            </>
          )}
          <span className="topology-editor__divider" />
          <button className={viewMode === "2d" ? "is-active" : ""} onClick={() => setViewMode("2d")} title={tr(locale, "平面视图", "Plan view")}>
            2D
          </button>
          <button
            className={`topology-editor__view-25d ${viewMode === "2.5d" ? "is-active" : ""}`}
            onClick={() => setViewMode("2.5d")}
            title={tr(locale, "2.5D 层级视图", "2.5D layered view")}
          >
            <Layers3 size={14} />
            2.5D
          </button>
          <span className="topology-editor__divider" />
          <button disabled={!canUndoTopologyEdit(editor)} onClick={() => dispatch({ type: "history.undo" })} title={tr(locale, "撤销 Ctrl+Z", "Undo Ctrl+Z")}>
            <Undo2 size={15} />
          </button>
          <button disabled={!canRedoTopologyEdit(editor)} onClick={() => dispatch({ type: "history.redo" })} title={tr(locale, "重做 Ctrl+Y", "Redo Ctrl+Y")}>
            <Redo2 size={15} />
          </button>
          <button disabled={!selection} onClick={removeSelection} title={tr(locale, "删除", "Delete")}>
            <Trash2 size={15} />
          </button>
        </div>
        <div className="topology-editor__actions">
          {onAutoSaveChange && (
            <label>
              <input type="checkbox" checked={autoSaveEnabled} onChange={(event) => onAutoSaveChange(event.target.checked)} />
              {tr(locale, "自动保存", "Auto save")}
            </label>
          )}
          {onInsertDashboard && (
            <button onClick={onInsertDashboard}>
              <LayoutDashboard size={14} />
              {tr(locale, "插入看板", "Insert into dashboard")}
            </button>
          )}
          {onSave && (
            <button disabled={!dirty || busy} onClick={onSave}>
              <Save size={14} />
              {tr(locale, "保存", "Save")}
            </button>
          )}
          {onPublish && (
            <button className="primary" disabled={busy} onClick={onPublish}>
              <CloudUpload size={14} />
              {tr(locale, "发布", "Publish")}
            </button>
          )}
        </div>
        <div className={`topology-editor__sync ${dirty ? "dirty" : ""}`}>
          <Check size={13} />
          {dirty ? tr(locale, "有未保存修改", "Unsaved changes") : tr(locale, "所有修改已保存", "All changes saved")}
        </div>
        {onClose && (
          <button className="topology-editor__close" onClick={onClose} aria-label={tr(locale, "关闭", "Close")}>
            <X size={17} />
          </button>
        )}
      </header>

      <aside className="topology-editor__palette">
        <label className="topology-editor__palette-search">
          <Search size={14} />
          <input
            value={paletteQuery}
            onChange={(event) => setPaletteQuery(event.target.value)}
            placeholder={tr(locale, "搜索设备或类型", "Search devices or types")}
          />
        </label>
        {presetGroups.map((group) => (
          <section key={group.id} className={`topology-editor__preset-group is-${group.id}`}>
            <div className="topology-editor__section-title">
              <span>{locale === "zh-CN" ? group.labelZh : group.labelEn}</span>
              <small>{group.presets.length}</small>
            </div>
            <div className="topology-editor__presets">
              {group.presets.map((preset) => (
                <button key={preset.kind} onClick={() => addNode(preset)}>
                  <span><preset.icon size={17} /></span>
                  <span>
                    <strong>{locale === "zh-CN" ? preset.labelZh : preset.labelEn}</strong>
                    <small>{preset.kind}</small>
                  </span>
                  <Plus size={14} />
                </button>
              ))}
            </div>
          </section>
        ))}
        {presetGroups.length === 0 && (
          <div className="topology-editor__palette-empty">{tr(locale, "没有匹配的工业图元", "No matching industrial symbols")}</div>
        )}
        <div className="topology-editor__hint">
          <CircleDot size={14} />
          <span>
            {tr(
              locale,
              "Shift/Ctrl 多选，Ctrl+D 复制；运行值由适配器注入，拓扑只保存点位、阈值与关系。",
              "Shift/Ctrl selects multiple nodes and Ctrl+D duplicates; live values come from adapters.",
            )}
          </span>
        </div>
      </aside>

      <main className={`topology-editor__viewport ${tool === "connect" ? "is-connecting" : ""} ${viewMode === "2.5d" ? "is-2-5d" : ""}`}>
        {runtimeSummary.total > 0 && (
          <div className="topology-editor__runtime-overview" role="status" aria-label={tr(locale, "SCADA 运行诊断", "SCADA runtime diagnostics")}>
            <span className="is-healthy">
              <ShieldCheck size={13} />
              <strong>
                {runtimeSummary.healthy}/{runtimeSummary.total}
              </strong>
              {tr(locale, "健康", "healthy")}
            </span>
            <span className={runtimeSummary.missing + runtimeSummary.offline > 0 ? "has-issue" : ""}>
              <WifiOff size={13} />
              <strong>{runtimeSummary.missing + runtimeSummary.offline}</strong>
              {tr(locale, "失联", "unreachable")}
            </span>
            <span className={runtimeSummary.stale + runtimeSummary.undated + runtimeSummary.invalidTimestamp > 0 ? "has-issue" : ""}>
              <CircleDot size={13} />
              <strong>{runtimeSummary.stale + runtimeSummary.undated + runtimeSummary.invalidTimestamp}</strong>
              {tr(locale, "时效异常", "timestamp issues")}
            </span>
            <span className={runtimeSummary.badQuality + runtimeSummary.uncertainQuality > 0 ? "has-issue" : ""}>
              <Gauge size={13} />
              <strong>{runtimeSummary.badQuality + runtimeSummary.uncertainQuality}</strong>
              {tr(locale, "质量异常", "quality issues")}
            </span>
            {activeAlarms.length > 0 && (
              <span className="has-alarm">
                <AlertTriangle size={13} />
                <strong>{activeAlarms.length}</strong>
                {tr(locale, "告警", "alarms")}
                {runtimeSummary.unacknowledgedAlarms > 0 && (
                  <em>
                    {runtimeSummary.unacknowledgedAlarms} {tr(locale, "未确认", "unacknowledged")}
                  </em>
                )}
              </span>
            )}
          </div>
        )}
        <div className="topology-editor__canvas-stage" style={{ width: CANVAS_WIDTH * zoom, height: CANVAS_HEIGHT * zoom }}>
          <div
            className="topology-editor__canvas"
            ref={canvasRef}
            style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${zoom})`, transformOrigin: "top left" }}
            onClick={() => dispatch({ type: "selection.set", selection: [] })}
          >
          <svg className="topology-editor__edges" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} aria-hidden="true">
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {edgeGeometry.map(({ edge, source, target }) => {
              const selected = selection?.kind === "edge" && selection.id === edge.id;
              const medium = topologyEdgeMedium(edge);
              const animated = topologyEdgeAnimated(edge);
              const stateClass = topologyEdgeStateClass(runtimeStates[source.id], runtimeStates[target.id]);
              const sourcePosition = topologyProjectedPosition(source, viewMode);
              const targetPosition = topologyProjectedPosition(target, viewMode);
              const x1 = sourcePosition.x + NODE_WIDTH;
              const y1 = sourcePosition.y + NODE_HEIGHT / 2;
              const x2 = targetPosition.x;
              const y2 = targetPosition.y + NODE_HEIGHT / 2;
              const curve = Math.max(70, Math.abs(x2 - x1) * 0.45);
              const path = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
              const label = topologyEdgeLabel(edge);
              return (
                <g
                  key={edge.id}
                  className={`${selected ? "is-selected" : ""} is-${medium} ${animated ? "is-animated" : ""} ${stateClass}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    dispatch({ type: "selection.set", selection: [{ kind: "edge", id: edge.id }] });
                  }}
                >
                  <path className="topology-editor__edge-hit" d={path} />
                  <path className="topology-editor__edge-line" d={path} markerEnd={`url(#${markerId})`} />
                  {label && (
                    <text className="topology-editor__edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 7} textAnchor="middle">
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {editor.document.nodes.map((node) => {
            const selected = selectedNodeIds.includes(node.id);
            const connecting = connectionSourceId === node.id;
            const nodeBinding = topologyNodeDataBinding(node);
            const scada = isTopologyScadaNode(node);
            const runtimeState = runtimeStates[node.id];
            const runtimeAssessment = assessTopologyScadaRuntime(runtimeState, runtimeNowMs, runtimeStaleAfterMs);
            const operatingState = runtimeState?.state ?? "unknown";
            const basePosition = drag?.nodeId === node.id && dragPosition ? { ...node, ...dragPosition } : node;
            const position = topologyProjectedPosition(basePosition, viewMode);
            const elevation = topologyNodeElevation(node);
            const Icon = NODE_PRESETS.find((preset) => preset.kind === node.kind)?.icon ?? Box;
            const nodeClassName = [
              "topology-editor__node",
              selected && "is-selected",
              connecting && "is-source",
              scada && `is-scada is-state-${operatingState} is-freshness-${runtimeAssessment.freshness} is-quality-${runtimeAssessment.quality}`,
              runtimeState?.alarm?.active && "has-alarm",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={node.id}
                className={nodeClassName}
                style={{ left: position.x, top: position.y, ...(viewMode === "2.5d" ? ({ "--topology-depth": `${Math.max(6, 10 + elevation * 0.12)}px` } as CSSProperties) : {}) }}
                onClick={(event) => {
                  event.stopPropagation();
                  selectNode(node.id, event.shiftKey || event.ctrlKey || event.metaKey);
                }}
                onPointerDown={(event) => beginDrag(event, node)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <span className="topology-editor__port topology-editor__port--in" />
                <span className="topology-editor__node-icon">
                  <Icon size={18} />
                </span>
                <span className="topology-editor__node-copy">
                  <strong>{topologyNodeLabel(node)}</strong>
                  <small>{scada ? scadaStateLabel(locale, operatingState) : node.kind}</small>
                  {scada && runtimeState?.value !== undefined && <em>{formatScadaValue(runtimeState.value, runtimeState.unit ?? topologyNodeScadaConfig(node)?.unit)}</em>}
                </span>
                {scada && (
                  <span
                    className={`topology-editor__status-dot is-${operatingState}`}
                    title={`${scadaStateLabel(locale, operatingState)} · ${qualityLabel(locale, runtimeAssessment.quality)} · ${runtimeAssessmentLabel(locale, runtimeAssessment)}`}
                  />
                )}
                {runtimeState?.alarm?.active && (
                  <span className={`topology-editor__alarm-badge is-${runtimeState.alarm.severity}`} title={runtimeState.alarm.message}>
                    <AlertTriangle size={11} />
                  </span>
                )}
                {nodeBinding && (
                  <span className="topology-editor__binding-dot" title={tr(locale, "已绑定数据", "Data bound")}>
                    <Database size={11} />
                  </span>
                )}
                <span className="topology-editor__port topology-editor__port--out" />
              </button>
            );
          })}
          {editor.document.nodes.length === 0 && (
            <div className="topology-editor__empty">
              <span>
                <Workflow size={24} />
              </span>
              <strong>{tr(locale, "从左侧添加第一个节点", "Add the first node from the library")}</strong>
              <small>{tr(locale, "设备关系保持轻量，并可直接绑定数据中台产品。", "Keep relationships lightweight and bind data products directly.")}</small>
            </div>
          )}
          </div>
        </div>
        <div className="topology-editor__zoom" role="toolbar" aria-label={tr(locale, "画布缩放", "Canvas zoom")}>
          <button onClick={zoomOut} disabled={zoom <= 0.6} title={tr(locale, "缩小", "Zoom out")} aria-label={tr(locale, "缩小", "Zoom out")}><ZoomOut size={14} /></button>
          <button className="topology-editor__zoom-value" onClick={resetZoom} title={tr(locale, "重置为 100%", "Reset to 100%")}>{Math.round(zoom * 100)}%</button>
          <button onClick={zoomIn} disabled={zoom >= 1.5} title={tr(locale, "放大", "Zoom in")} aria-label={tr(locale, "放大", "Zoom in")}><ZoomIn size={14} /></button>
        </div>
        {tool === "connect" && (
          <div className="topology-editor__mode-tip">
            {connectionSourceId ? tr(locale, "选择目标节点，Esc 取消", "Choose a target node, Esc to cancel") : tr(locale, "选择连线起点", "Choose a source node")}
          </div>
        )}
        {operationError && (
          <button className="topology-editor__error" onClick={() => setOperationError(undefined)}>
            <span>{operationError}</span>
            <X size={13} />
          </button>
        )}
      </main>

      <aside className="topology-editor__inspector">
        <div className="topology-editor__section-title">
          <span>{tr(locale, "属性", "Inspector")}</span>
          {selection && <small>{selection.kind === "node" ? tr(locale, "节点", "Node") : tr(locale, "连线", "Edge")}</small>}
        </div>
        {selectedNode && (
          <div className="topology-editor__form">
            <InspectorTextField
              label={tr(locale, "名称", "Name")}
              value={topologyNodeLabel(selectedNode)}
              onCommit={(label) => dispatch({ type: "node.update", nodeId: selectedNode.id, patch: { properties: { ...selectedNode.properties, label } } })}
            />
            <InspectorTextField
              label={tr(locale, "类型", "Type")}
              value={selectedNode.kind}
              onCommit={(kind) => dispatch({ type: "node.update", nodeId: selectedNode.id, patch: { kind } })}
            />
            <div className="topology-editor__coordinates">
              <InspectorNumberField
                label="X"
                value={selectedNode.x}
                onCommit={(x) => dispatch({ type: "node.move", positions: [{ nodeId: selectedNode.id, x, y: selectedNode.y }] })}
              />
              <InspectorNumberField
                label="Y"
                value={selectedNode.y}
                onCommit={(y) => dispatch({ type: "node.move", positions: [{ nodeId: selectedNode.id, x: selectedNode.x, y }] })}
              />
              <InspectorNumberField
                label={tr(locale, "层高", "Elevation")}
                value={topologyNodeElevation(selectedNode)}
                onCommit={(elevation) => dispatch({ type: "node.update", nodeId: selectedNode.id, patch: { properties: { ...selectedNode.properties, elevation } } })}
              />
            </div>
            {scadaConfig && (
              <>
                <div className="topology-editor__form-divider" />
                <div className="topology-editor__form-heading topology-editor__form-heading--scada">
                  <Gauge size={14} />
                  <span>SCADA</span>
                </div>
                <InspectorTextField label={tr(locale, "点位标签", "Point tag")} value={scadaConfig.tag} placeholder="P-101.PV" onCommit={(tag) => updateScadaConfig({ tag })} />
                <InspectorTextField
                  label={tr(locale, "工程单位", "Engineering unit")}
                  value={scadaConfig.unit}
                  placeholder="bar / °C / kW"
                  onCommit={(unit) => updateScadaConfig({ unit })}
                />
                <div className="topology-editor__coordinates">
                  <InspectorOptionalNumberField
                    label={tr(locale, "低限告警", "Low alarm")}
                    value={scadaConfig.lowAlarm}
                    onCommit={(lowAlarm) => updateScadaThreshold("lowAlarm", lowAlarm)}
                  />
                  <InspectorOptionalNumberField
                    label={tr(locale, "高限告警", "High alarm")}
                    value={scadaConfig.highAlarm}
                    onCommit={(highAlarm) => updateScadaThreshold("highAlarm", highAlarm)}
                  />
                </div>
                <label>
                  <span>{tr(locale, "告警级别", "Alarm severity")}</span>
                  <select
                    value={scadaConfig.alarmSeverity}
                    onChange={(event) => updateScadaConfig({ alarmSeverity: event.target.value as TopologyScadaNodeConfig["alarmSeverity"] })}
                  >
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="critical">Critical</option>
                  </select>
                </label>
                <ScadaRuntimeCard
                  locale={locale}
                  state={selectedRuntimeState}
                  assessment={selectedRuntimeAssessment}
                  unit={scadaConfig.unit}
                  canAcknowledge={Boolean(onAcknowledgeAlarm)}
                  acknowledgePending={acknowledgePendingNodeId === selectedNode.id}
                  onAcknowledge={acknowledgeAlarm}
                />
              </>
            )}
            <div className="topology-editor__form-divider" />
            <div className="topology-editor__form-heading">
              <Database size={14} />
              <span>{tr(locale, "数据绑定", "Data binding")}</span>
            </div>
            <label>
              <span>{tr(locale, "数据产品", "Data product")}</span>
              <select value={binding ? `${binding.productType}:${binding.productId}` : ""} onChange={(event) => setBindingProduct(event.target.value)}>
                <option value="">{tr(locale, "未绑定", "Unbound")}</option>
                {dataProducts.filter((product) => product.type === "pipeline").length > 0 && (
                  <optgroup label={tr(locale, "数据管道", "Pipelines")}>
                    {dataProducts
                      .filter((product) => product.type === "pipeline")
                      .map((product) => (
                        <option key={`${product.type}:${product.id}`} value={`${product.type}:${product.id}`}>
                          {product.name}
                        </option>
                      ))}
                  </optgroup>
                )}
                {dataProducts.filter((product) => product.type === "dataset").length > 0 && (
                  <optgroup label={tr(locale, "数据集", "Datasets")}>
                    {dataProducts
                      .filter((product) => product.type === "dataset")
                      .map((product) => (
                        <option key={`${product.type}:${product.id}`} value={`${product.type}:${product.id}`}>
                          {product.name}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </label>
            {binding &&
              (selectedProduct?.fields?.length ? (
                <label>
                  <span>{tr(locale, "状态字段", "State field")}</span>
                  <select
                    value={binding.field}
                    onChange={(event) => dispatch({ type: "binding.set", nodeId: selectedNode.id, binding: { ...binding, field: event.target.value } })}
                  >
                    {selectedProduct.fields.map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <InspectorTextField
                  label={tr(locale, "状态字段", "State field")}
                  value={binding.field}
                  placeholder="status"
                  onCommit={(field) => dispatch({ type: "binding.set", nodeId: selectedNode.id, binding: { ...binding, field } })}
                />
              ))}
            {dataProducts.length === 0 && (
              <p className="topology-editor__form-note">
                {tr(locale, "创建数据集或数据管道后，可在这里绑定设备状态。", "Create a dataset or pipeline to bind device state here.")}
              </p>
            )}
          </div>
        )}
        {selectedEdge && (
          <div className="topology-editor__form topology-editor__edge-form">
            <div className="topology-editor__edge-card">
              <span>
                <Link2 size={16} />
              </span>
              <div>
                <strong>{tr(locale, "有向连接", "Directed connection")}</strong>
                <small>
                  {nodeName(editor.document, selectedEdge.sourceNodeId)} → {nodeName(editor.document, selectedEdge.targetNodeId)}
                </small>
              </div>
            </div>
            <InspectorTextField
              label={tr(locale, "管线名称", "Flow label")}
              value={topologyEdgeLabel(selectedEdge)}
              placeholder={tr(locale, "例如：冷却水供水", "For example: cooling water supply")}
              onCommit={(label) => updateEdgeProperties({ label })}
            />
            <label>
              <span>{tr(locale, "介质 / 信号", "Medium / signal")}</span>
              <select value={topologyEdgeMedium(selectedEdge)} onChange={(event) => updateEdgeProperties({ medium: event.target.value })}>
                <option value="signal">{tr(locale, "控制信号", "Control signal")}</option>
                <option value="power">{tr(locale, "电力", "Power")}</option>
                <option value="water">{tr(locale, "水 / 液体", "Water / liquid")}</option>
                <option value="air">{tr(locale, "空气 / 气体", "Air / gas")}</option>
                <option value="material">{tr(locale, "物料", "Material")}</option>
              </select>
            </label>
            <label className="topology-editor__edge-flow-toggle">
              <input type="checkbox" checked={topologyEdgeAnimated(selectedEdge)} onChange={(event) => updateEdgeProperties({ animated: event.target.checked })} />
              <span>{tr(locale, "显示流向动画", "Animate flow direction")}</span>
            </label>
          </div>
        )}
        {!selection && (
          <div className="topology-editor__inspector-empty">
            <MousePointer2 size={20} />
            <strong>{tr(locale, "选择节点或连线", "Select a node or edge")}</strong>
            <small>{tr(locale, "在这里配置名称、位置与数据绑定。", "Configure names, positions and data bindings here.")}</small>
          </div>
        )}
      </aside>

      <footer className="topology-editor__footer">
        <span>
          {editor.document.nodes.length} {tr(locale, "节点", "nodes")}
        </span>
        <span>
          {editor.document.edges.length} {tr(locale, "连线", "edges")}
        </span>
        <span>
          {activeAlarms.length} {tr(locale, "活动告警", "active alarms")}
        </span>
        <span className="topology-editor__footer-spacer" />
        <span>
          {tr(locale, "视图", "View")} {viewMode}
        </span>
        <span>
          {tr(locale, "网格", "Grid")} {GRID_SIZE}px
        </span>
        <span>{tr(locale, "拓扑 / SCADA", "Topology / SCADA")}</span>
      </footer>
    </section>
  );
}
