import type { OntologyActionType, OntologyGraphEdge, OntologyGraphNode, OntologyPackage, OntologyRelationType } from "@bim-studio/contracts";
import { parseOntologyGraphNodeId } from "@bim-studio/contracts";
import { Archive, CheckCircle2, CornerUpLeft, Eye, Focus, Minimize2, PencilLine } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { StatusBadge } from "./OntologyWorkspace";
import { actionRiskPresentation, GRAPH_NODE_KIND_META } from "./ontologyGraphLogic";

/**
 * 图谱检查器：点击节点/边后的属性/来源/版本/权限/证据明细（方案 §4.3）。
 * 数据源是包全量（OntologyPackage），图谱节点只带摘要——明细永远可追溯到契约原文。
 */
export type GraphSelection = { kind: "node"; id: string } | { kind: "edge"; id: string } | undefined;

function StatusText({ status }: { status: OntologyPackage["status"] }) {
  const icon = status === "published" ? <CheckCircle2 size={12} /> : status === "review" ? <Eye size={12} /> : status === "retired" ? <Archive size={12} /> : <PencilLine size={12} />;
  return <span className={`ontology-graph-status-text is-${status}`}>{icon}{{ draft: "草稿", review: "待评审", published: "已发布", retired: "已退役" }[status]}</span>;
}

function RelationEvidence({ relation, locale }: { relation: OntologyRelationType; locale: AppLocale }) {
  return (
    <section>
      <h4>{tr(locale, `证据 (${relation.evidence.length})`, `Evidence (${relation.evidence.length})`)}</h4>
      {relation.evidence.length === 0 && <small>{tr(locale, "无证据条目", "No evidence entries")}</small>}
      <ul className="ontology-graph-evidence">
        {relation.evidence.map((item, index) => (
          <li key={index}>
            <strong>{item.source}</strong>
            <small>{item.sampleCount !== undefined ? `N=${item.sampleCount} · ` : ""}{new Date(item.recordedAt).toLocaleString()}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActionMeta({ action, locale }: { action: OntologyActionType; locale: AppLocale }) {
  const risk = actionRiskPresentation(action.riskLevel);
  return (
    <>
      <dl>
        <dt>{tr(locale, "效果", "Effect")}</dt><dd>{action.effect}</dd>
        <dt>{tr(locale, "风险", "Risk")}</dt><dd><span className={`ontology-graph-risk is-${risk.tone}`}>{risk.label}</span></dd>
        <dt>{tr(locale, "审批", "Approval")}</dt><dd>{action.approvalRequired ? tr(locale, "需要", "Required") : tr(locale, "不需要", "Not required")}</dd>
        <dt>{tr(locale, "幂等键", "Idempotency")}</dt><dd>{action.idempotencyRequired ? tr(locale, "要求", "Required") : tr(locale, "不要求", "Not required")}</dd>
        <dt>{tr(locale, "能力绑定", "Tool binding")}</dt><dd>{action.toolBinding.kind}:{action.toolBinding.id || "—"}@{action.toolBinding.version || "—"}</dd>
        <dt>{tr(locale, "影响范围", "Impact scope")}</dt><dd>{action.impactScope.join(", ") || "—"}</dd>
        <dt>{tr(locale, "授权范围", "Authorized scopes")}</dt><dd>{action.authorizedScopes.join(", ") || "—"}</dd>
        <dt>{tr(locale, "回滚说明", "Rollback")}</dt><dd>{action.rollback || "—"}</dd>
        {action.preconditions.length > 0 && (
          <>
            <dt>{tr(locale, "前置条件", "Preconditions")}</dt>
            <dd>{action.preconditions.map((item) => item.label).join("；")}</dd>
          </>
        )}
      </dl>
      <p className="ontology-graph-hint">{tr(locale, "行动预览与受控执行在 Harness 链路（H-C4-P3）接入；当前为只读定义视图。", "Action preview and controlled execution arrive with the Harness chain (H-C4-P3); this is the read-only definition view.")}</p>
    </>
  );
}

function NodeDetail({ pkg, node, locale, onFocusRoot, onCollapse }: {
  pkg: OntologyPackage | undefined;
  node: OntologyGraphNode;
  locale: AppLocale;
  onFocusRoot: (node: OntologyGraphNode) => void;
  onCollapse: (node: OntologyGraphNode) => void;
}) {
  const meta = GRAPH_NODE_KIND_META[node.kind];
  if (node.kind === "object") {
    const object = pkg?.objects.find((item) => item.key === node.key);
    const inbound = pkg?.relations.filter((relation) => relation.targetObject === node.key) ?? [];
    const outbound = pkg?.relations.filter((relation) => relation.sourceObject === node.key) ?? [];
    const actions = pkg?.actions.filter((action) => action.boundObject === node.key) ?? [];
    const events = pkg?.events.filter((event) => event.boundObject === node.key) ?? [];
    return (
      <>
        <dl>
          <dt>{tr(locale, "类型", "Kind")}</dt><dd>{tr(locale, meta.zh, meta.en)}</dd>
          <dt>key</dt><dd>{node.key}</dd>
          <dt>{tr(locale, "业务域", "Domain")}</dt><dd>{object?.domain || "—"}</dd>
          <dt>Owner</dt><dd>{object?.owner || "—"}</dd>
          <dt>{tr(locale, "状态/版本", "Status/version")}</dt><dd><StatusText status={node.status} /> v{node.version}</dd>
          <dt>{tr(locale, "主键", "Primary keys")}</dt><dd>{object?.primaryKeys.join(", ") || "—"}</dd>
          <dt>{tr(locale, "别名", "Aliases")}</dt><dd>{object?.aliases.join(", ") || "—"}</dd>
        </dl>
        <section>
          <h4>{tr(locale, `属性 (${object?.properties.length ?? 0})`, `Properties (${object?.properties.length ?? 0})`)}</h4>
          {(object?.properties ?? []).length === 0 && <small>{tr(locale, "未声明属性", "No properties")}</small>}
          <ul className="ontology-graph-evidence">
            {(object?.properties ?? []).map((property) => (
              <li key={property.key}>
                <strong>{property.key}</strong>
                <small>{property.label} · {property.type}{property.confirmed ? "" : tr(locale, " · 待确认", " · pending")}</small>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h4>{tr(locale, "来源绑定", "Source bindings")}</h4>
          {(object?.sourceBindings ?? []).length === 0 && <small>{tr(locale, "无来源(不可发布)", "No sources (cannot publish)")}</small>}
          <ul className="ontology-graph-evidence">
            {(object?.sourceBindings ?? []).map((binding, index) => (
              <li key={`${binding.kind}-${binding.sourceId}-${index}`}>
                <strong>{binding.kind}:{binding.sourceId}</strong>
                <small>{binding.schemaFingerprint ? `fp:${binding.schemaFingerprint.slice(0, 10)}…` : tr(locale, "无指纹", "no fingerprint")}</small>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h4>{tr(locale, `关系 (出 ${outbound.length} / 入 ${inbound.length})`, `Relations (out ${outbound.length} / in ${inbound.length})`)}</h4>
          <ul className="ontology-graph-evidence">
            {[...outbound, ...inbound].map((relation) => (
              <li key={relation.id}><strong>{relation.key}</strong><small>{relation.sourceObject} → {relation.targetObject} · {relation.cardinality}</small></li>
            ))}
            {outbound.length + inbound.length === 0 && <li><small>{tr(locale, "无关系", "None")}</small></li>}
          </ul>
        </section>
        <section>
          <h4>{tr(locale, `可用行动 (${actions.length})`, `Actions (${actions.length})`)}</h4>
          <ul className="ontology-graph-evidence">
            {actions.map((action) => (
              <li key={action.id}><strong>{action.label || action.key}</strong><small>{action.effect} · {action.riskLevel}{action.approvalRequired ? tr(locale, " · 需审批", " · approval") : ""}</small></li>
            ))}
            {actions.length === 0 && <li><small>{tr(locale, "无行动绑定", "None")}</small></li>}
          </ul>
        </section>
        <section>
          <h4>{tr(locale, `事件 (${events.length})`, `Events (${events.length})`)}</h4>
          <ul className="ontology-graph-evidence">
            {events.map((event) => <li key={event.id}><strong>{event.label || event.key}</strong><small>{tr(locale, "绑定对象", "bound")} {event.boundObject}</small></li>)}
            {events.length === 0 && <li><small>{tr(locale, "无事件绑定", "None")}</small></li>}
          </ul>
        </section>
        <div className="ontology-graph-inspector-actions">
          <button type="button" onClick={() => onFocusRoot(node)}><Focus size={12} />{tr(locale, "以此为根展开", "Expand from here")}</button>
          <button type="button" onClick={() => onCollapse(node)}><Minimize2 size={12} />{tr(locale, "折叠邻居", "Collapse neighbors")}</button>
        </div>
      </>
    );
  }
  if (node.kind === "action") {
    const action = pkg?.actions.find((item) => item.key === node.key);
    return (
      <>
        <dl>
          <dt>{tr(locale, "类型", "Kind")}</dt><dd>{tr(locale, meta.zh, meta.en)}</dd>
          <dt>{tr(locale, "状态/版本", "Status/version")}</dt><dd><StatusText status={node.status} /> v{node.version}</dd>
          <dt>{tr(locale, "绑定对象", "Bound object")}</dt><dd>{action?.boundObject || "—"}</dd>
        </dl>
        {action ? <ActionMeta action={action} locale={locale} /> : <small>{tr(locale, "行动定义缺失", "Action definition missing")}</small>}
        <div className="ontology-graph-inspector-actions">
          <button type="button" onClick={() => onFocusRoot(node)}><Focus size={12} />{tr(locale, "以此为根展开", "Expand from here")}</button>
          <button type="button" onClick={() => onCollapse(node)}><Minimize2 size={12} />{tr(locale, "折叠邻居", "Collapse neighbors")}</button>
        </div>
      </>
    );
  }
  if (node.kind === "event") {
    const event = pkg?.events.find((item) => item.key === node.key);
    return (
      <>
        <dl>
          <dt>{tr(locale, "类型", "Kind")}</dt><dd>{tr(locale, meta.zh, meta.en)}</dd>
          <dt>{tr(locale, "状态/版本", "Status/version")}</dt><dd><StatusText status={node.status} /> v{node.version}</dd>
          <dt>{tr(locale, "绑定对象", "Bound object")}</dt><dd>{event?.boundObject || "—"}</dd>
          <dt>{tr(locale, "说明", "Description")}</dt><dd>{event?.description || "—"}</dd>
        </dl>
        <div className="ontology-graph-inspector-actions">
          <button type="button" onClick={() => onFocusRoot(node)}><Focus size={12} />{tr(locale, "以此为根展开", "Expand from here")}</button>
        </div>
      </>
    );
  }
  // dataset：跨对象聚合来源绑定（对象 → 数据 的 describes 反查）
  const boundObjects = (pkg?.objects ?? []).filter((object) => object.sourceBindings.some((binding) => binding.sourceId === node.key));
  return (
    <>
      <dl>
        <dt>{tr(locale, "类型", "Kind")}</dt><dd>{tr(locale, meta.zh, meta.en)}</dd>
        <dt>sourceId</dt><dd>{node.key}</dd>
      </dl>
      <section>
        <h4>{tr(locale, `消费对象 (${boundObjects.length})`, `Consuming objects (${boundObjects.length})`)}</h4>
        <ul className="ontology-graph-evidence">
          {boundObjects.map((object) => (
            <li key={object.id}>
              <strong>{object.label || object.key}</strong>
              <small>{object.sourceBindings.filter((binding) => binding.sourceId === node.key).map((binding) => binding.kind).join(", ")} · {tr(locale, `${object.properties.length} 属性`, `${object.properties.length} props`)}</small>
            </li>
          ))}
          {boundObjects.length === 0 && <li><small>{tr(locale, "无对象绑定", "None")}</small></li>}
        </ul>
      </section>
      <div className="ontology-graph-inspector-actions">
        <button type="button" onClick={() => onFocusRoot(node)}><Focus size={12} />{tr(locale, "以此为根展开", "Expand from here")}</button>
      </div>
    </>
  );
}

function EdgeDetail({ pkg, edge, locale }: { pkg: OntologyPackage | undefined; edge: OntologyGraphEdge; locale: AppLocale }) {
  if (edge.kind === "relation") {
    const relation = pkg?.relations.find((item) => `rel:${item.id}` === edge.id);
    return (
      <>
        <dl>
          <dt>{tr(locale, "关系定义", "Relation")}</dt><dd>{relation?.label || edge.label} <code>{edge.relationKey}</code></dd>
          <dt>{tr(locale, "方向", "Direction")}</dt><dd>{edge.direction === "directed" ? tr(locale, "有向", "directed") : tr(locale, "无向", "undirected")}</dd>
          <dt>{tr(locale, "基数", "Cardinality")}</dt><dd>{relation?.cardinality ?? "—"}</dd>
          <dt>{tr(locale, "键映射", "Key mapping")}</dt><dd>{relation ? `${relation.keyMapping.sourceField || "—"} → ${relation.keyMapping.targetField || "—"}` : "—"}</dd>
          <dt>{tr(locale, "来源", "Source")}</dt><dd>{relation ? `${relation.source.kind}${relation.source.sourceId ? `:${relation.source.sourceId}` : ""}` : "—"}</dd>
          <dt>{tr(locale, "建立理由", "Rationale")}</dt><dd>{relation?.source.note || "—"}</dd>
          <dt>{tr(locale, "有效时间", "Valid time")}</dt><dd>{relation?.validTime ? `${relation.validTime.from ?? "…"} ~ ${relation.validTime.to ?? "…"}` : tr(locale, "长期有效", "always")}</dd>
          <dt>{tr(locale, "状态/版本", "Status/version")}</dt><dd><StatusText status={edge.status} /> v{pkg?.relations.find((item) => item.id === edge.id.slice(4))?.version ?? "—"}</dd>
        </dl>
        {relation && <RelationEvidence relation={relation} locale={locale} />}
      </>
    );
  }
  if (edge.kind === "action") {
    const action = pkg?.actions.find((item) => `act:${item.id}` === edge.id);
    return (
      <dl>
        <dt>{tr(locale, "边语义", "Semantics")}</dt><dd>acts-on</dd>
        <dt>{tr(locale, "行动", "Action")}</dt><dd>{action?.label || action?.key || "—"}</dd>
        <dt>{tr(locale, "绑定对象", "Bound object")}</dt><dd>{action?.boundObject || "—"}</dd>
        <dt>{tr(locale, "效果/风险", "Effect/risk")}</dt><dd>{action ? `${action.effect} · ${action.riskLevel}` : "—"}</dd>
      </dl>
    );
  }
  if (edge.kind === "event") {
    const event = pkg?.events.find((item) => `evt:${item.id}` === edge.id);
    return (
      <dl>
        <dt>{tr(locale, "边语义", "Semantics")}</dt><dd>triggers-on</dd>
        <dt>{tr(locale, "事件", "Event")}</dt><dd>{event?.label || event?.key || "—"}</dd>
        <dt>{tr(locale, "绑定对象", "Bound object")}</dt><dd>{event?.boundObject || "—"}</dd>
      </dl>
    );
  }
  // data：对象来源绑定边（dataset→object）
  const parsed = parseOntologyGraphNodeId(edge.target);
  const object = parsed?.kind === "object" ? pkg?.objects.find((item) => item.key === parsed.key) : undefined;
  const binding = object?.sourceBindings.find((item) => item.sourceId === edge.source);
  return (
    <dl>
      <dt>{tr(locale, "边语义", "Semantics")}</dt><dd>describes</dd>
      <dt>{tr(locale, "对象", "Object")}</dt><dd>{object?.label || object?.key || "—"}</dd>
      <dt>{tr(locale, "绑定类型", "Binding kind")}</dt><dd>{binding?.kind ?? "—"}</dd>
      <dt>{tr(locale, "Schema 指纹", "Schema fingerprint")}</dt><dd>{binding?.schemaFingerprint ? `fp:${binding.schemaFingerprint.slice(0, 10)}…` : tr(locale, "无指纹(需人工复核)", "none (manual review)")}</dd>
    </dl>
  );
}

/** 检查器外壳：节点/边统一入口；无选中时给操作引导。 */
export default function OntologyGraphInspector({ pkg, selection, node, edge, locale, onFocusRoot, onCollapse, onReset }: {
  pkg: OntologyPackage | undefined;
  selection: GraphSelection;
  node: OntologyGraphNode | undefined;
  edge: OntologyGraphEdge | undefined;
  locale: AppLocale;
  onFocusRoot: (node: OntologyGraphNode) => void;
  onCollapse: (node: OntologyGraphNode) => void;
  onReset: () => void;
}) {
  return (
    <aside className="ontology-graph-inspector" aria-label={tr(locale, "图谱检查器", "Graph inspector")}>
      {selection === undefined && (
        <div className="ontology-graph-inspector-empty">
          <CornerUpLeft size={16} />
          <p>{tr(locale, "点击节点或边查看属性、来源、版本与证据。", "Click a node or edge to inspect properties, sources, versions and evidence.")}</p>
          <button type="button" onClick={onReset}>{tr(locale, "重置视图", "Reset view")}</button>
        </div>
      )}
      {selection?.kind === "node" && (
        node
          ? <NodeDetail pkg={pkg} node={node} locale={locale} onFocusRoot={onFocusRoot} onCollapse={onCollapse} />
          : <p className="ontology-graph-hint">{tr(locale, "节点不在当前子图内。", "Node is not in the current subgraph.")}</p>
      )}
      {selection?.kind === "edge" && (
        edge
          ? <EdgeDetail pkg={pkg} edge={edge} locale={locale} />
          : <p className="ontology-graph-hint">{tr(locale, "边不在当前子图内。", "Edge is not in the current subgraph.")}</p>
      )}
    </aside>
  );
}

export { StatusText };
