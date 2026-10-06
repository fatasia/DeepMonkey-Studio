import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  CheckCircle2,
  Database,
  Eye,
  GitBranch,
  LoaderCircle,
  Package as PackageIcon,
  PencilLine,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import type {
  DataDatasetRecord,
  OntologyActionType,
  OntologyObjectType,
  OntologyPackage,
  OntologyProperty,
  OntologyRelationType,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  datasetSourceBinding,
  newActionDraft,
  newObjectDraft,
  newRelationDraft,
  objectPropertiesFromDataset,
  ONTOLOGY_ASSET_KINDS,
  ontologySaveErrors,
  ontologyStatusPresentation,
  packageEditMode,
  summarizeGate,
  type OntologyAssetKind,
} from "./ontologyWorkspaceLogic";
import { useOntologyWorkspace } from "./useOntologyWorkspace";
import "./OntologyWorkspace.css";

type WorkspacePackage = OntologyPackage;

const ASSET_META: Record<OntologyAssetKind, { labelZh: string; labelEn: string; icon: typeof PackageIcon }> = {
  objects: { labelZh: "对象", labelEn: "Objects", icon: PackageIcon },
  relations: { labelZh: "关系", labelEn: "Relations", icon: GitBranch },
  actions: { labelZh: "行动", labelEn: "Actions", icon: Zap },
};

export function StatusBadge({ status, locale }: { status: WorkspacePackage["status"]; locale: AppLocale }) {
  const { label, tone } = ontologyStatusPresentation(status);
  const icon = status === "published" ? <CheckCircle2 size={13} /> : status === "review" ? <Eye size={13} /> : status === "retired" ? <Archive size={13} /> : <PencilLine size={13} />;
  const en = { draft: "Draft", review: "In review", published: "Published", retired: "Retired" }[status];
  return (
    <span className={`ontology-status ontology-status-${tone}`}>
      {icon}
      {tr(locale, label, en)}
    </span>
  );
}

export function AssetList({
  kind, pkg, locale, selectedId, onSelect, onCreate, onDelete,
}: {
  kind: OntologyAssetKind;
  pkg: WorkspacePackage;
  locale: AppLocale;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  const items: Array<{ id: string; key: string; label: string; extra: string }> = kind === "objects"
    ? pkg.objects.map((item) => ({ id: item.id, key: item.key, label: item.label || item.key, extra: `${item.properties.length} ${tr(locale, "属性", "properties")} · ${item.sourceBindings.length} ${tr(locale, "来源", "sources")}` }))
    : kind === "relations"
      ? pkg.relations.map((item) => ({ id: item.id, key: item.key, label: item.label || item.key, extra: `${item.sourceObject} → ${item.targetObject} · ${item.cardinality}` }))
      : pkg.actions.map((item) => ({ id: item.id, key: item.key, label: item.label || item.key, extra: `${item.effect} · ${item.riskLevel}${item.approvalRequired ? ` · ${tr(locale, "需审批", "approval")}` : ""}` }));
  return (
    <div className="ontology-asset-list">
      <header>
        <strong>{tr(locale, ASSET_META[kind].labelZh, ASSET_META[kind].labelEn)}</strong>
        <button type="button" onClick={onCreate} title={tr(locale, `新建${ASSET_META[kind].labelZh}`, `New ${ASSET_META[kind].labelEn.toLowerCase().slice(0, -1)}`)}>
          <Plus size={13} />
        </button>
      </header>
      {items.length === 0 && <p className="ontology-asset-empty">{tr(locale, "暂无资产,点击 + 新建", "No assets yet; use + to create")}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id} className={selectedId === item.id ? "active" : ""}>
            <button type="button" onClick={() => onSelect(item.id)}>
              <strong>{item.label}</strong>
              <small>{item.key}</small>
              <small>{item.extra}</small>
            </button>
            <button type="button" className="danger" aria-label={tr(locale, "删除", "Delete")} onClick={() => onDelete(item.id)}>
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PropertyEditor({
  properties, locale, onChange,
}: {
  properties: OntologyProperty[];
  locale: AppLocale;
  onChange: (next: OntologyProperty[]) => void;
}) {
  const update = (index: number, patch: Partial<OntologyProperty>) => {
    onChange(properties.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };
  return (
    <div className="ontology-property-editor">
      <header>
        <strong>{tr(locale, "属性", "Properties")}</strong>
        <small>{tr(locale, "未确认属性会阻止发布(门禁 1)", "Unconfirmed properties block publishing (gate 1)")}</small>
      </header>
      {properties.map((property, index) => (
        <div key={`${property.key}-${index}`} className="ontology-property-row">
          <input value={property.key} aria-label={tr(locale, "属性标识", "Property key")} onChange={(event) => update(index, { key: event.target.value })} />
          <input value={property.label} aria-label={tr(locale, "属性名称", "Property label")} onChange={(event) => update(index, { label: event.target.value })} />
          <select value={property.type} aria-label={tr(locale, "属性类型", "Property type")} onChange={(event) => update(index, { type: event.target.value as OntologyProperty["type"] })}>
            {["string", "number", "boolean", "datetime", "enum", "json"].map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <label className="ontology-confirm-toggle">
            <input type="checkbox" checked={property.confirmed} onChange={(event) => update(index, { confirmed: event.target.checked })} />
            {property.confirmed ? tr(locale, "已确认", "Confirmed") : tr(locale, "待确认", "Pending")}
          </label>
          <button type="button" className="danger" aria-label={tr(locale, "移除属性", "Remove property")} onClick={() => onChange(properties.filter((_, itemIndex) => itemIndex !== index))}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...properties, { key: `prop_${properties.length + 1}`, label: "", type: "string", confirmed: false }])}>
        <Plus size={12} />
        {tr(locale, "手动加属性", "Add property")}
      </button>
    </div>
  );
}

function ObjectForm({
  value, datasets, locale, onChange,
}: {
  value: OntologyObjectType;
  datasets: DataDatasetRecord[];
  locale: AppLocale;
  onChange: (next: OntologyObjectType) => void;
}) {
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>("");
  const selectedDataset = datasets.find((item) => item.id === selectedDatasetId);
  const generateCandidates = () => {
    if (!selectedDataset) return;
    const candidates = objectPropertiesFromDataset(selectedDataset);
    onChange({
      ...value,
      properties: [...value.properties.filter((existing) => !candidates.some((candidate) => candidate.key === existing.key)), ...candidates],
      sourceBindings: [...value.sourceBindings.filter((binding) => binding.sourceId !== selectedDataset.id), datasetSourceBinding(candidates, selectedDataset)],
    });
  };
  return (
    <div className="ontology-form">
      <div className="ontology-form-grid">
        <label><span>{tr(locale, "标识 (key)", "Key")}</span><input value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })} /></label>
        <label><span>{tr(locale, "名称", "Label")}</span><input value={value.label} onChange={(event) => onChange({ ...value, label: event.target.value })} /></label>
        <label><span>{tr(locale, "业务域", "Domain")}</span><input value={value.domain} onChange={(event) => onChange({ ...value, domain: event.target.value })} /></label>
        <label><span>{tr(locale, "Owner", "Owner")}</span><input value={value.owner} onChange={(event) => onChange({ ...value, owner: event.target.value })} /></label>
        <label><span>{tr(locale, "展示字段", "Display key")}</span>
          <select value={value.displayKey ?? ""} onChange={(event) => onChange({ ...value, ...(event.target.value ? { displayKey: event.target.value } : {}) })}>
            <option value="">{tr(locale, "(主键回落)", "(fall back to primary key)")}</option>
            {value.properties.map((property) => <option key={property.key} value={property.key}>{property.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "别名 (逗号分隔)", "Aliases (comma separated)")}</span>
          <input value={value.aliases.join(", ")} onChange={(event) => onChange({ ...value, aliases: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} />
        </label>
      </div>
      <div className="ontology-candidate-row">
        <label>
          <span>{tr(locale, "从数据集生成属性候选", "Generate property candidates from dataset")}</span>
          <select value={selectedDatasetId} onChange={(event) => setSelectedDatasetId(event.target.value)}>
            <option value="">{tr(locale, "选择数据集", "Select a dataset")}</option>
            {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
          </select>
        </label>
        <button type="button" disabled={!selectedDataset} onClick={generateCandidates}>
          <Database size={13} />
          {tr(locale, "生成候选", "Generate candidates")}
        </button>
      </div>
      <PropertyEditor properties={value.properties} locale={locale} onChange={(properties) => onChange({ ...value, properties })} />
      <fieldset>
        <legend>{tr(locale, "主键 (勾选已确认属性)", "Primary keys (check confirmed properties)")}</legend>
        {value.properties.length === 0 && <small>{tr(locale, "先添加属性", "Add properties first")}</small>}
        {value.properties.map((property) => (
          <label key={property.key} className="ontology-confirm-toggle">
            <input
              type="checkbox"
              checked={value.primaryKeys.includes(property.key)}
              onChange={(event) => onChange({
                ...value,
                primaryKeys: event.target.checked
                  ? [...value.primaryKeys, property.key]
                  : value.primaryKeys.filter((item) => item !== property.key),
              })}
            />
            {property.key}{property.confirmed ? "" : tr(locale, "(待确认)", " (pending)")}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{tr(locale, "来源绑定", "Source bindings")}</legend>
        {value.sourceBindings.length === 0 && <small>{tr(locale, "发布要求至少一个来源(门禁 1)", "Publishing requires at least one source (gate 1)")}</small>}
        {value.sourceBindings.map((binding, index) => (
          <div key={`${binding.kind}-${binding.sourceId}-${index}`} className="ontology-binding-row">
            <strong>{binding.kind}</strong>
            <span>{binding.sourceId}</span>
            <small>{binding.schemaFingerprint ? `fp:${binding.schemaFingerprint.slice(0, 12)}…` : tr(locale, "无指纹", "no fingerprint")}</small>
            <label className="ontology-confirm-toggle" title={tr(locale, "数据源字段变更后需人工确认无漂移(门禁 8)", "Confirm no schema drift after source changes (gate 8)")}>
              <input
                type="checkbox"
                checked={Boolean(binding.driftReviewed)}
                onChange={(event) => onChange({
                  ...value,
                  sourceBindings: value.sourceBindings.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...(event.target.checked ? { driftReviewed: true } : {}) } : entry)),
                })}
              />
              {tr(locale, "已复核漂移", "Drift reviewed")}
            </label>
            <button type="button" className="danger" aria-label={tr(locale, "移除来源", "Remove binding")} onClick={() => onChange({ ...value, sourceBindings: value.sourceBindings.filter((_, itemIndex) => itemIndex !== index) })}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </fieldset>
    </div>
  );
}

function RelationForm({
  value, pkg, locale, onChange,
}: {
  value: OntologyRelationType;
  pkg: WorkspacePackage;
  locale: AppLocale;
  onChange: (next: OntologyRelationType) => void;
}) {
  const sourceObject = pkg.objects.find((item) => item.key === value.sourceObject);
  const targetObject = pkg.objects.find((item) => item.key === value.targetObject);
  return (
    <div className="ontology-form">
      <div className="ontology-form-grid">
        <label><span>{tr(locale, "标识 (key)", "Key")}</span><input value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })} /></label>
        <label><span>{tr(locale, "名称", "Label")}</span><input value={value.label} onChange={(event) => onChange({ ...value, label: event.target.value })} /></label>
        <label><span>{tr(locale, "来源对象", "Source object")}</span>
          <select value={value.sourceObject} onChange={(event) => onChange({ ...value, sourceObject: event.target.value })}>
            {pkg.objects.map((item) => <option key={item.key} value={item.key}>{item.label || item.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "目标对象", "Target object")}</span>
          <select value={value.targetObject} onChange={(event) => onChange({ ...value, targetObject: event.target.value })}>
            {pkg.objects.map((item) => <option key={item.key} value={item.key}>{item.label || item.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "基数", "Cardinality")}</span>
          <select value={value.cardinality} onChange={(event) => onChange({ ...value, cardinality: event.target.value as OntologyRelationType["cardinality"] })}>
            {["one-to-one", "one-to-many", "many-to-one", "many-to-many"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "方向", "Direction")}</span>
          <select value={value.direction} onChange={(event) => onChange({ ...value, direction: event.target.value as OntologyRelationType["direction"] })}>
            <option value="directed">directed</option>
            <option value="undirected">undirected</option>
          </select>
        </label>
        <label><span>{tr(locale, "键映射源字段", "Key mapping source field")}</span>
          <select value={value.keyMapping.sourceField} onChange={(event) => onChange({ ...value, keyMapping: { ...value.keyMapping, sourceField: event.target.value } })}>
            <option value="">{tr(locale, "(选择)", "(select)")}</option>
            {sourceObject?.properties.map((property) => <option key={property.key} value={property.key}>{property.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "键映射目标字段", "Key mapping target field")}</span>
          <select value={value.keyMapping.targetField} onChange={(event) => onChange({ ...value, keyMapping: { ...value.keyMapping, targetField: event.target.value } })}>
            <option value="">{tr(locale, "(选择)", "(select)")}</option>
            {targetObject?.properties.map((property) => <option key={property.key} value={property.key}>{property.key}</option>)}
          </select>
        </label>
      </div>
      <label><span>{tr(locale, "建立理由 (必填,没有理由的边不允许发布)", "Rationale (required; edges without rationale cannot be published)")}</span>
        <input value={value.source.note} onChange={(event) => onChange({ ...value, source: { ...value.source, note: event.target.value } })} />
      </label>
      <fieldset>
        <legend>{tr(locale, "证据 (至少一条)", "Evidence (at least one)")}</legend>
        {value.evidence.length === 0 && <small>{tr(locale, "发布要求关系有证据(门禁 2)", "Publishing requires evidence on relations (gate 2)")}</small>}
        {value.evidence.map((item, index) => (
          <div key={index} className="ontology-binding-row">
            <input value={item.source} aria-label={tr(locale, "证据来源", "Evidence source")} onChange={(event) => onChange({ ...value, evidence: value.evidence.map((entry, entryIndex) => (entryIndex === index ? { ...entry, source: event.target.value } : entry)) })} />
            <input type="number" min={0} value={item.sampleCount ?? ""} placeholder="N" aria-label={tr(locale, "样例数", "Sample count")} onChange={(event) => onChange({ ...value, evidence: value.evidence.map((entry, entryIndex) => (entryIndex === index ? { source: entry.source, recordedAt: entry.recordedAt, ...(event.target.value ? { sampleCount: Number(event.target.value) } : {}) } : entry)) })} />
            <button type="button" className="danger" aria-label={tr(locale, "移除证据", "Remove evidence")} onClick={() => onChange({ ...value, evidence: value.evidence.filter((_, entryIndex) => entryIndex !== index) })}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => onChange({ ...value, evidence: [...value.evidence, { source: "", recordedAt: new Date().toISOString() }] })}>
          <Plus size={12} />
          {tr(locale, "加证据", "Add evidence")}
        </button>
      </fieldset>
    </div>
  );
}

function ActionForm({
  value, pkg, locale, onChange,
}: {
  value: OntologyActionType;
  pkg: WorkspacePackage;
  locale: AppLocale;
  onChange: (next: OntologyActionType) => void;
}) {
  const risky = value.riskLevel === "high" || value.riskLevel === "critical";
  const writeEffect = value.effect === "external-write" || value.effect === "control";
  return (
    <div className="ontology-form">
      <div className="ontology-form-grid">
        <label><span>{tr(locale, "标识 (key)", "Key")}</span><input value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })} /></label>
        <label><span>{tr(locale, "名称", "Label")}</span><input value={value.label} onChange={(event) => onChange({ ...value, label: event.target.value })} /></label>
        <label><span>{tr(locale, "绑定对象", "Bound object")}</span>
          <select value={value.boundObject} onChange={(event) => onChange({ ...value, boundObject: event.target.value, impactScope: [event.target.value] })}>
            <option value="">{tr(locale, "(选择)", "(select)")}</option>
            {pkg.objects.map((item) => <option key={item.key} value={item.key}>{item.label || item.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "能力类型", "Tool binding kind")}</span>
          <select value={value.toolBinding.kind} onChange={(event) => onChange({ ...value, toolBinding: { ...value.toolBinding, kind: event.target.value as OntologyActionType["toolBinding"]["kind"] } })}>
            {["capability", "mcp", "api", "workflow"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "能力 ID", "Capability id")}</span><input value={value.toolBinding.id} onChange={(event) => onChange({ ...value, toolBinding: { ...value.toolBinding, id: event.target.value } })} /></label>
        <label><span>{tr(locale, "能力版本 (门禁 3)", "Capability version (gate 3)")}</span><input value={value.toolBinding.version} onChange={(event) => onChange({ ...value, toolBinding: { ...value.toolBinding, version: event.target.value } })} /></label>
        <label><span>{tr(locale, "效果", "Effect")}</span>
          <select value={value.effect} onChange={(event) => onChange({ ...value, effect: event.target.value as OntologyActionType["effect"] })}>
            {["read", "analyze", "internal-write", "external-write", "control"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "风险级别", "Risk level")}</span>
          <select value={value.riskLevel} onChange={(event) => onChange({ ...value, riskLevel: event.target.value as OntologyActionType["riskLevel"] })}>
            {["low", "medium", "high", "critical"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </div>
      <div className="ontology-toggle-row">
        <label className="ontology-confirm-toggle">
          <input type="checkbox" checked={value.approvalRequired} onChange={(event) => onChange({ ...value, approvalRequired: event.target.checked })} />
          {tr(locale, "需要审批", "Approval required")}
        </label>
        <label className="ontology-confirm-toggle">
          <input type="checkbox" checked={value.idempotencyRequired} onChange={(event) => onChange({ ...value, idempotencyRequired: event.target.checked })} />
          {tr(locale, "要求幂等键", "Idempotency required")}
        </label>
        <label className="ontology-confirm-toggle">
          <input type="checkbox" checked={value.evidenceRequired} onChange={(event) => onChange({ ...value, evidenceRequired: event.target.checked })} />
          {tr(locale, "要求证据回执", "Evidence receipt required")}
        </label>
      </div>
      {(risky || writeEffect) && (
        <p className="ontology-hint" role="note">
          {tr(locale, "高风险或写入/控制行动:门禁 5 强制要求审批、幂等键与回滚说明;写入/控制还必须要求证据回执。", "High-risk or write/control actions: gate 5 enforces approval, idempotency and rollback notes; write/control also requires evidence receipts.")}
        </p>
      )}
      <div className="ontology-form-grid">
        <label><span>{tr(locale, "回滚说明", "Rollback note")}</span>
          <input
            value={value.rollback ?? ""}
            onChange={(event) => {
              const next: OntologyActionType = { ...value };
              if (event.target.value) next.rollback = event.target.value;
              else delete next.rollback;
              onChange(next);
            }}
          />
        </label>
        <label><span>{tr(locale, "影响范围 (对象 key,逗号分隔)", "Impact scope (object keys)")}</span><input value={value.impactScope.join(", ")} onChange={(event) => onChange({ ...value, impactScope: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>
        <label><span>{tr(locale, "授权范围 (逗号分隔)", "Authorized scopes (comma separated)")}</span><input value={value.authorizedScopes.join(", ")} onChange={(event) => onChange({ ...value, authorizedScopes: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>
        <label><span>{tr(locale, "前置条件 (分号分隔)", "Preconditions (semicolon separated)")}</span>
          <input
            value={value.preconditions.map((item) => item.label).join("; ")}
            onChange={(event) => onChange({ ...value, preconditions: event.target.value.split(";").map((item) => item.trim()).filter(Boolean).map((label) => ({ label })) })}
          />
        </label>
      </div>
    </div>
  );
}

function Inspector({
  pkg, validation, versions, locale,
}: {
  pkg: WorkspacePackage | undefined;
  validation: ReturnType<typeof useOntologyWorkspace>["validation"];
  versions: ReturnType<typeof useOntologyWorkspace>["versions"];
  locale: AppLocale;
}) {
  if (!pkg) return null;
  const gate = validation ? summarizeGate(validation.gate) : undefined;
  return (
    <aside className="ontology-inspector" aria-label={tr(locale, "检查器", "Inspector")}>
      <section>
        <h4>{pkg.name || tr(locale, "(未命名包)", "(unnamed package)")}</h4>
        <dl>
          <dt>{tr(locale, "状态", "Status")}</dt>
          <dd><StatusBadge status={pkg.status} locale={locale} /></dd>
          <dt>{tr(locale, "版本", "Version")}</dt>
          <dd>v{pkg.version} · rev {pkg.revision}</dd>
          <dt>Owner</dt>
          <dd>{pkg.owner || tr(locale, "(未填)", "(missing)")}</dd>
          <dt>{tr(locale, "资产", "Assets")}</dt>
          <dd>{tr(locale, `${pkg.objects.length} 对象 · ${pkg.relations.length} 关系 · ${pkg.actions.length} 行动`, `${pkg.objects.length} objects · ${pkg.relations.length} relations · ${pkg.actions.length} actions`)}</dd>
          <dt>{tr(locale, "影响分析", "Impact review")}</dt>
          <dd>{pkg.impactReviewed ? tr(locale, `已复核 (${pkg.impactReviewedBy ?? "—"})`, `Reviewed (${pkg.impactReviewedBy ?? "—"})`) : tr(locale, "未复核(门禁 9)", "Not reviewed (gate 9)")}</dd>
        </dl>
      </section>
      {validation && (
        <section>
          <h4>{tr(locale, `发布门禁 ${gate?.passed}/${gate?.total} 通过`, `Publish gates ${gate?.passed}/${gate?.total} passed`)}</h4>
          <ul className="ontology-gate-list">
            {validation.gate.gates.map((item) => (
              <li key={item.gateId} className={item.passed ? "passed" : "failed"}>
                <strong>{item.passed ? "✓" : "✕"} {item.gateId}. {item.label}</strong>
                {item.errors.map((error, index) => <small key={index}>{error}</small>)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {versions && (
        <section>
          <h4>{tr(locale, `发布版本 (${versions.versions.length})`, `Published versions (${versions.versions.length})`)}</h4>
          <ul className="ontology-version-list">
            {versions.versions.length === 0 && <li><small>{tr(locale, "尚无发布快照", "No snapshots yet")}</small></li>}
            {versions.versions.map((item) => (
              <li key={item.snapshotId}>
                <strong>v{item.version}</strong>
                <small>{item.publishedBy} · {new Date(item.publishedAt).toLocaleString()}</small>
                <small title={item.fingerprint}>fp:{item.fingerprint.slice(0, 10)}…</small>
              </li>
            ))}
          </ul>
          <h4>{tr(locale, "变更历史", "History")}</h4>
          <ul className="ontology-version-list">
            {versions.history.slice(0, 8).map((item, index) => (
              <li key={index}>
                <strong>{item.action}</strong>
                <small>{item.by} · {new Date(item.at).toLocaleString()}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

export default function OntologyWorkspace({
  projectId, locale, owner, onDirtyChange,
}: {
  projectId: string;
  locale: AppLocale;
  owner: string;
  /** 编辑草稿未保存时上报,供数据中心离开确认(与指标编辑同一 dirty 通道)。 */
  onDirtyChange: ((dirty: boolean) => void) | undefined;
}) {
  const workspace = useOntologyWorkspace(projectId, owner);
  const [assetKind, setAssetKind] = useState<OntologyAssetKind>("objects");
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [newPackageName, setNewPackageName] = useState("");
  useEffect(() => {
    onDirtyChange?.(Boolean(workspace.draft));
  }, [workspace.draft, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const editing = workspace.draft !== undefined;
  const editable = workspace.currentPackage ? packageEditMode(workspace.currentPackage.status) === "editable" : true;
  const counts: Record<OntologyAssetKind, number> = useMemo(() => {
    const source = workspace.draft ?? workspace.currentPackage;
    return {
      objects: source?.objects.length ?? 0,
      relations: source?.relations.length ?? 0,
      actions: source?.actions.length ?? 0,
    };
  }, [workspace.draft, workspace.currentPackage]);

  const draftAsset = useMemo(() => {
    const source = workspace.draft;
    if (!source || !selectedAssetId) return undefined;
    if (assetKind === "objects") return source.objects.find((item) => item.id === selectedAssetId);
    if (assetKind === "relations") return source.relations.find((item) => item.id === selectedAssetId);
    return source.actions.find((item) => item.id === selectedAssetId);
  }, [assetKind, selectedAssetId, workspace.draft]);

  const updateDraftAsset = (next: unknown) => {
    if (!workspace.draft) return;
    const draft = structuredClone(workspace.draft);
    if (assetKind === "objects") draft.objects = draft.objects.map((item) => (item.id === selectedAssetId ? (next as OntologyObjectType) : item));
    else if (assetKind === "relations") draft.relations = draft.relations.map((item) => (item.id === selectedAssetId ? (next as OntologyRelationType) : item));
    else draft.actions = draft.actions.map((item) => (item.id === selectedAssetId ? (next as OntologyActionType) : item));
    workspace.setDraft(draft);
  };

  const createAsset = () => {
    if (!workspace.draft) return;
    const draft = structuredClone(workspace.draft);
    const created = assetKind === "objects"
      ? newObjectDraft(draft)
      : assetKind === "relations"
        ? newRelationDraft(draft)
        : newActionDraft(draft);
    if (assetKind === "objects") draft.objects.push(created as OntologyObjectType);
    else if (assetKind === "relations") draft.relations.push(created as OntologyRelationType);
    else draft.actions.push(created as OntologyActionType);
    workspace.setDraft(draft);
    setSelectedAssetId(created.id);
  };

  const deleteAsset = (id: string) => {
    if (!workspace.draft) return;
    const draft = structuredClone(workspace.draft);
    if (assetKind === "objects") draft.objects = draft.objects.filter((item) => item.id !== id);
    else if (assetKind === "relations") draft.relations = draft.relations.filter((item) => item.id !== id);
    else draft.actions = draft.actions.filter((item) => item.id !== id);
    workspace.setDraft(draft);
    if (selectedAssetId === id) setSelectedAssetId(undefined);
  };

  if (workspace.status === "loading") {
    return <p role="status" className="ontology-loading"><LoaderCircle className="spin" size={15} /> {tr(locale, "正在加载本体包…", "Loading ontology packages…")}</p>;
  }

  return (
    <section className="ontology-workspace" aria-label={tr(locale, "语义与本体", "Semantics and ontology")}>
      {workspace.notice && <p className="ontology-notice" role="status">{workspace.notice}</p>}
      {workspace.errors.length > 0 && (
        <div className="ontology-error" role="alert">
          <ul>{workspace.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
          <button type="button" onClick={() => void workspace.reload()}>{tr(locale, "重新读取", "Reload")}</button>
        </div>
      )}
      <header className="ontology-toolbar">
        <label>
          <span>{tr(locale, "本体包", "Package")}</span>
          <select value={workspace.selectedPackageId ?? ""} onChange={(event) => { setSelectedAssetId(undefined); workspace.selectPackage(event.target.value); }}>
            <option value="">{tr(locale, "(选择本体包)", "(select a package)")}</option>
            {workspace.packages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {workspace.currentPackage && (
          <>
            <StatusBadge status={workspace.currentPackage.status} locale={locale} />
            <span className="ontology-version-chip">v{workspace.currentPackage.version}</span>
            <div className="ontology-toolbar-actions">
              {!editing && editable && <button type="button" onClick={() => void workspace.editCurrent()}>{tr(locale, "编辑", "Edit")}</button>}
              {!editing && workspace.currentPackage.status === "published" && (
                <button type="button" onClick={() => void workspace.cloneDraft()}>{tr(locale, "开新草稿", "New draft version")}</button>
              )}
              {editing && <button type="button" disabled={workspace.busy} onClick={() => void workspace.saveDraft()}>{tr(locale, "保存草稿", "Save draft")}</button>}
              {editing && <button type="button" disabled={workspace.busy} onClick={() => void workspace.validateDraft()}>{tr(locale, "校验", "Validate")}</button>}
              {!editing && workspace.currentPackage.status === "draft" && <button type="button" disabled={workspace.busy} onClick={() => void workspace.submitReview()}>{tr(locale, "提交评审", "Submit review")}</button>}
              {!editing && workspace.currentPackage.status === "review" && <button type="button" className="primary" disabled={workspace.busy} onClick={() => void workspace.publish()}>{tr(locale, "发布", "Publish")}</button>}
              {!editing && workspace.currentPackage.status === "review" && <button type="button" disabled={workspace.busy} onClick={() => void workspace.rejectReview()}>{tr(locale, "驳回", "Reject")}</button>}
              {!editing && <button type="button" disabled={workspace.busy} onClick={() => void workspace.loadVersions()}>{tr(locale, "版本", "Versions")}</button>}
              {!editing && workspace.currentPackage.status === "published" && (
                <button type="button" className="danger" disabled={workspace.busy} onClick={() => { if (window.confirm(tr(locale, "退役后不可恢复为可用状态,确认?", "Retire this package? This cannot be undone."))) void workspace.retire(); }}>
                  {tr(locale, "退役", "Retire")}
                </button>
              )}
              {!editing && (workspace.currentPackage.status === "draft" || workspace.currentPackage.status === "review") && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => { if (window.confirm(tr(locale, "删除该本体包草稿?", "Delete this draft package?"))) void workspace.deletePackage(workspace.currentPackage!.id); }}
                >
                  <Trash2 size={13} />
                  {tr(locale, "删除", "Delete")}
                </button>
              )}
              {editing && <button type="button" onClick={() => { workspace.setDraft(undefined); workspace.setValidation(undefined); }}>{tr(locale, "取消编辑", "Cancel editing")}</button>}
            </div>
          </>
        )}
        <button
          type="button"
          aria-label={tr(locale, "刷新本体包", "Refresh packages")}
          disabled={workspace.busy}
          onClick={() => void workspace.reload()}
        >
          <RefreshCw size={14} />
        </button>
      </header>

      {!workspace.currentPackage ? (
        <div className="ontology-empty">
          <PackageIcon size={30} />
          <h3>{tr(locale, "先创建一个本体包", "Create your first ontology package")}</h3>
          <p>{tr(locale, "对象、关系、行动与指标在一个版本化包内定义;发布走九条门禁,未确认候选不会被发布。", "Objects, relations, actions and metrics live in one versioned package; publishing passes nine gates, and unconfirmed candidates never ship.")}</p>
          <div className="ontology-empty-form">
            <label>
              <span>{tr(locale, "包名称", "Package name")}</span>
              <input value={newPackageName} onChange={(event) => setNewPackageName(event.target.value)} placeholder={tr(locale, "例如:产线设备本体", "e.g. Production device ontology")} />
            </label>
            <button type="button" className="primary" disabled={!newPackageName.trim() || workspace.busy} onClick={() => void workspace.createPackage(newPackageName.trim(), "manufacturing")}>
              <Plus size={14} />
              {tr(locale, "创建草稿", "Create draft")}
            </button>
          </div>
        </div>
      ) : editing && workspace.draft ? (
        <div className="ontology-columns">
          <nav className="ontology-nav" aria-label={tr(locale, "本体资产", "Ontology assets")}>
            {ONTOLOGY_ASSET_KINDS.map((kind) => {
              const Icon = ASSET_META[kind].icon;
              return (
                <button key={kind} type="button" className={assetKind === kind ? "active" : ""} onClick={() => { setAssetKind(kind); setSelectedAssetId(undefined); }}>
                  <Icon size={14} />
                  <span>{tr(locale, ASSET_META[kind].labelZh, ASSET_META[kind].labelEn)}</span>
                  <b>{counts[kind]}</b>
                </button>
              );
            })}
          </nav>
          <div className="ontology-main">
            <div className="ontology-main-split">
              <AssetList
                kind={assetKind}
                pkg={workspace.draft}
                locale={locale}
                selectedId={selectedAssetId}
                onSelect={setSelectedAssetId}
                onCreate={createAsset}
                onDelete={deleteAsset}
              />
              <div className="ontology-editor">
                {draftAsset === undefined && <p className="ontology-asset-empty">{tr(locale, "从左侧选择或新建一项资产", "Select or create an asset on the left")}</p>}
                {draftAsset !== undefined && assetKind === "objects" && (
                  <ObjectForm value={draftAsset as OntologyObjectType} datasets={workspace.datasets} locale={locale} onChange={updateDraftAsset} />
                )}
                {draftAsset !== undefined && assetKind === "relations" && (
                  <RelationForm value={draftAsset as OntologyRelationType} pkg={workspace.draft} locale={locale} onChange={updateDraftAsset} />
                )}
                {draftAsset !== undefined && assetKind === "actions" && (
                  <ActionForm value={draftAsset as OntologyActionType} pkg={workspace.draft} locale={locale} onChange={updateDraftAsset} />
                )}
              </div>
            </div>
            <Inspector pkg={workspace.draft} validation={workspace.validation} versions={undefined} locale={locale} />
          </div>
        </div>
      ) : (
        <div className="ontology-columns">
          <div className="ontology-main">
            {/* 只读总览不进 ontology-main-split 两列壳(230px+1fr):单子元素会全压进 230px 首列,中部整片空置。 */}
            <div className="ontology-readonly-summary">
              {ONTOLOGY_ASSET_KINDS.map((kind) => {
                const Icon = ASSET_META[kind].icon;
                const sample = kind === "objects"
                  ? workspace.currentPackage!.objects.slice(0, 6)
                  : kind === "relations"
                    ? workspace.currentPackage!.relations.slice(0, 6)
                    : workspace.currentPackage!.actions.slice(0, 6);
                return (
                  <section key={kind}>
                    <h4><Icon size={13} /> {tr(locale, ASSET_META[kind].labelZh, ASSET_META[kind].labelEn)} ({counts[kind]})</h4>
                    {sample.length === 0 && <small>{tr(locale, "暂无", "None")}</small>}
                    <ul>
                      {sample.map((item) => (
                        <li key={item.id}>
                          <strong>{item.label || item.key}</strong>
                          <small>{item.key}</small>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
            <Inspector pkg={workspace.currentPackage} validation={undefined} versions={workspace.versions} locale={locale} />
          </div>
        </div>
      )}
    </section>
  );
}
