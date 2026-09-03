import type { DragEvent, ReactNode } from "react";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  Box,
  Calculator,
  CheckCircle2,
  Code2,
  Columns3,
  CopyMinus,
  Database,
  Filter,
  GitBranch,
  GripVertical,
  ListEnd,
  Sigma,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  DataDatasetRecord,
  DataDatasetField,
  DataFieldType,
  DataPipelineDefinition,
  DataPipelineNode,
  DataPipelineNodeDiagnostic,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

export type TransformNodeType = "filter" | "formula" | "script" | "select" | "deduplicate" | "aggregate" | "sort" | "limit";

export function validatePipelineDraft(draft: DataPipelineDefinition, datasets: DataDatasetRecord[]): string | undefined {
  if (!draft.name.trim()) return "流水线名称不能为空";
  const source = draft.nodes.find((node) => node.type === "source");
  if (!source) return "请添加数据源节点";
  if (!datasets.some((dataset) => dataset.id === source.datasetId)) return "数据源引用的数据集不存在";
  if (draft.nodes.filter((node) => node.type === "output").length !== 1) return "必须保留一个输出节点";
  if (draft.nodes.some((node) => !node.name.trim())) return "节点名称不能为空";
  const transform = draft.nodes.find((node) => node.type === "filter" && !node.formula.trim());
  if (transform) return `节点“${transform.name}”缺少过滤条件`;
  const formula = draft.nodes.find((node) => node.type === "formula" && (!node.key.trim() || !node.formula.trim()));
  if (formula) return `节点“${formula.name}”需要输出字段和公式`;
  const script = draft.nodes.find((node) => node.type === "script" && (!node.key.trim() || !node.source.trim()));
  if (script) return `节点“${script.name}”需要输出字段和脚本`;
  const select = draft.nodes.find((node) => node.type === "select" && node.fields.length === 0);
  if (select) return `节点“${select.name}”至少需要保留一个字段`;
  const aggregate = draft.nodes.find((node) => node.type === "aggregate" && (!node.outputKey.trim() || (node.operation !== "count" && !node.field.trim())));
  if (aggregate) return `节点“${aggregate.name}”需要汇总字段和输出字段`;
  const sort = draft.nodes.find((node) => node.type === "sort" && !node.field.trim());
  if (sort) return `节点“${sort.name}”需要排序字段`;
  const limit = draft.nodes.find((node) => node.type === "limit" && (!Number.isInteger(node.count) || node.count < 1 || node.count > 10000));
  if (limit) return `节点“${limit.name}”的行数必须为 1～10000`;
  return undefined;
}

export function PipelineNodeCard({
  node,
  selected,
  diagnostic,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onSelect,
}: {
  node: DataPipelineNode;
  selected: boolean;
  diagnostic?: DataPipelineNodeDiagnostic | undefined;
  draggable: boolean;
  onDragStart: () => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onSelect: () => void;
}) {
  return (
    <button
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`pipeline-node ${selected ? "selected" : ""} ${diagnostic?.status ?? ""}`}
      onClick={onSelect}
    >
      <span className="pipeline-node-icon">
        {draggable && <GripVertical size={11} />}
        {nodeIcon(node.type)}
      </span>
      <span>
        <small>{nodeTypeLabel(node.type)}</small>
        <strong>{node.name}</strong>
        <em>{nodeSummary(node)}</em>
      </span>
      {diagnostic && (
        <b
          title={`${diagnostic.inputRows} → ${diagnostic.outputRows} · ${diagnostic.durationMs.toFixed(1)}ms`}
        >
          {diagnostic.status === "success" ? (
            <CheckCircle2 size={14} />
          ) : (
            <XCircle size={14} />
          )}
        </b>
      )}
    </button>
  );
}

export function NodeInspector({
  locale,
  node,
  datasets,
  sourceFields = [],
  onChange,
  onRemove,
  onMove,
}: {
  locale: AppLocale;
  node?: DataPipelineNode | undefined;
  datasets: DataDatasetRecord[];
  sourceFields?: DataDatasetField[];
  onChange: (updater: (node: DataPipelineNode) => DataPipelineNode) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, offset: -1 | 1) => void;
}) {
  if (!node)
    return (
      <section className="pipeline-inspector pipeline-panel-empty">
        {tr(locale, "选择节点查看配置", "Select a node to inspect")}
      </section>
    );
  const mutate = <T extends DataPipelineNode>(patch: Partial<T>) =>
    onChange((current) => ({ ...current, ...patch }) as DataPipelineNode);
  const fieldHints = sourceFields.length ? <div className="pipeline-field-hints"><span>{tr(locale, "可用字段", "Available fields")}</span>{sourceFields.map((field) => <button type="button" key={field.key} onClick={() => {
    if (node.type === "sort") onChange((current) => ({ ...current, field: field.key } as DataPipelineNode));
    else if (node.type === "filter") onChange((current) => ({ ...current, formula: `${node.formula}${node.formula.trim() && node.formula.trim() !== "TRUE" ? " " : ""}${field.key}` } as DataPipelineNode));
    else if (node.type === "formula") onChange((current) => ({ ...current, formula: `${node.formula}${node.formula.trim() ? " " : ""}${field.key}` } as DataPipelineNode));
  }}>{field.key}</button>)}</div> : null;
  return (
    <section className="pipeline-inspector">
      <header>
        <span>
          <strong>{tr(locale, "节点配置", "Node settings")}</strong>
          <small>{nodeTypeLabel(node.type)}</small>
        </span>
        <div>
          {node.type !== "source" && node.type !== "output" && (
            <>
              <button
                title={tr(locale, "向前移动", "Move left")}
                onClick={() => onMove(node.id, -1)}
              >
                <ArrowLeft size={13} />
              </button>
              <button
                title={tr(locale, "向后移动", "Move right")}
                onClick={() => onMove(node.id, 1)}
              >
                <ArrowRight size={13} />
              </button>
              <button
                className="danger"
                title={tr(locale, "删除节点", "Delete node")}
                onClick={() => onRemove(node.id)}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </header>
      <div className="pipeline-inspector-body">
        <label>
          <span>{tr(locale, "名称", "Name")}</span>
          <input
            value={node.name}
            onChange={(event) => mutate({ name: event.target.value })}
          />
        </label>
        {node.type === "source" && (
          <label>
            <span>{tr(locale, "数据集", "Dataset")}</span>
            <select
              value={node.datasetId}
              onChange={(event) => mutate({ datasetId: event.target.value })}
            >
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {node.type === "filter" && (
          <>
            <CodeField locale={locale} label={tr(locale, "保留条件", "Keep condition")} value={node.formula} placeholder="temperature > 30 AND running == TRUE" onChange={(formula) => mutate({ formula })} />
            {fieldHints}
          </>
        )}
        {node.type === "formula" && (
          <>
            <OutputFieldEditor locale={locale} node={node} mutate={mutate} />
            <CodeField
              locale={locale}
              label={tr(locale, "安全公式", "Safe formula")}
              value={node.formula}
              placeholder="ROUND(temperature * 1.8 + 32, 1)"
              onChange={(formula) => mutate({ formula })}
            />
            {fieldHints}
          </>
        )}
        {node.type === "script" && (
          <>
            <OutputFieldEditor locale={locale} node={node} mutate={mutate} />
            <CodeField
              locale={locale}
              label="JavaScript · QuickJS"
              value={node.source}
              placeholder="return input.temperature * 1.8 + 32;"
              onChange={(source) => mutate({ source })}
            />
            <small>
              {tr(
                locale,
                "隔离运行，无网络、文件、DOM 与 Node API。",
                "Runs in isolation without network, files, DOM or Node APIs.",
              )}
            </small>
          </>
        )}
        {node.type === "select" && (
          <FieldTokenPicker
            locale={locale}
            label={tr(locale, "保留字段", "Keep fields")}
            fields={sourceFields}
            selected={node.fields}
            onChange={(fields) => mutate({ fields })}
          />
        )}
        {node.type === "deduplicate" && (
          <>
            <FieldTokenPicker
              locale={locale}
              label={tr(locale, "判重字段", "Match fields")}
              fields={sourceFields}
              selected={node.fields}
              onChange={(fields) => mutate({ fields })}
            />
            <small>{tr(locale, "未选择字段时按整行去重。", "With no fields selected, entire rows are compared.")}</small>
          </>
        )}
        {node.type === "aggregate" && (
          <>
            <FieldTokenPicker
              locale={locale}
              label={tr(locale, "分组字段（可选）", "Group fields (optional)")}
              fields={sourceFields}
              selected={node.groupBy}
              onChange={(groupBy) => mutate({ groupBy })}
            />
            <div className="pipeline-field-pair">
              <label>
                <span>{tr(locale, "计算方式", "Operation")}</span>
                <select value={node.operation} onChange={(event) => mutate({ operation: event.target.value as typeof node.operation })}>
                  <option value="count">COUNT</option>
                  <option value="sum">SUM</option>
                  <option value="average">AVERAGE</option>
                  <option value="min">MIN</option>
                  <option value="max">MAX</option>
                </select>
              </label>
              <label>
                <span>{tr(locale, "数值字段", "Value field")}</span>
                <select disabled={node.operation === "count"} value={node.field} onChange={(event) => mutate({ field: event.target.value })}>
                  <option value="">{tr(locale, "请选择", "Select")}</option>
                  {sourceFields.map((field) => <option key={field.key} value={field.key}>{field.label || field.key}</option>)}
                </select>
              </label>
            </div>
            <label>
              <span>{tr(locale, "输出字段", "Output field")}</span>
              <input value={node.outputKey} onChange={(event) => mutate({ outputKey: event.target.value })} />
            </label>
          </>
        )}
        {node.type === "sort" && (
          <>
          <div className="pipeline-field-pair">
            <label>
              <span>{tr(locale, "字段", "Field")}</span>
              <input
                value={node.field}
                onChange={(event) => mutate({ field: event.target.value })}
              />
            </label>
            <label>
              <span>{tr(locale, "方向", "Direction")}</span>
              <select
                value={node.direction}
                onChange={(event) =>
                  mutate({ direction: event.target.value as "asc" | "desc" })
                }
              >
                <option value="asc">ASC</option>
                <option value="desc">DESC</option>
              </select>
            </label>
          </div>
          {fieldHints}
          </>
        )}
        {node.type === "limit" && (
          <label>
            <span>{tr(locale, "最多行数", "Maximum rows")}</span>
            <input
              type="number"
              min="1"
              max="10000"
              value={node.count}
              onChange={(event) =>
                mutate({
                  count: Math.max(
                    1,
                    Math.min(10000, Number(event.target.value)),
                  ),
                })
              }
            />
          </label>
        )}
        {node.type === "output" && (
          <small>
            {tr(
              locale,
              "输出会成为可供 2D、3D 和接口共用的数据产品。",
              "The output becomes a data product shared by 2D, 3D and endpoints.",
            )}
          </small>
        )}
      </div>
    </section>
  );
}

function OutputFieldEditor<
  T extends Extract<DataPipelineNode, { type: "formula" | "script" }>,
>({
  locale,
  node,
  mutate,
}: {
  locale: AppLocale;
  node: T;
  mutate: (patch: Partial<T>) => void;
}) {
  return (
    <>
      <div className="pipeline-field-pair">
        <label>
          <span>Key</span>
          <input
            value={node.key}
            onChange={(event) =>
              mutate({ key: event.target.value } as Partial<T>)
            }
          />
        </label>
        <label>
          <span>{tr(locale, "类型", "Type")}</span>
          <select
            value={node.fieldType}
            onChange={(event) =>
              mutate({
                fieldType: event.target.value as DataFieldType,
              } as Partial<T>)
            }
          >
            <option value="number">Number</option>
            <option value="string">String</option>
            <option value="boolean">Boolean</option>
            <option value="datetime">Datetime</option>
            <option value="json">JSON</option>
          </select>
        </label>
      </div>
      <label>
        <span>{tr(locale, "显示名", "Label")}</span>
        <input
          value={node.label}
          onChange={(event) =>
            mutate({ label: event.target.value } as Partial<T>)
          }
        />
      </label>
    </>
  );
}

function CodeField({
  label,
  value,
  placeholder,
  onChange,
}: {
  locale: AppLocale;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function NodeAddButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button title={label} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function createTransformNode(
  type: TransformNodeType,
  locale: AppLocale,
  sourceFields: DataDatasetField[] = [],
): DataPipelineNode {
  const base = { id: crypto.randomUUID(), position: { x: 0, y: 0 } };
  const fieldKeys = sourceFields.map((field) => field.key);
  const firstField = sourceFields[0];
  const firstFormulaField = sourceFields.find(
    (field) => field.type !== "json" && isFormulaFieldKey(field.key),
  );
  const firstNumericField = sourceFields.find(
    (field) => field.type === "number" && isFormulaFieldKey(field.key),
  );
  const firstSortField =
    sourceFields.find((field) => field.type === "datetime") ?? firstField;
  if (type === "filter")
    return {
      ...base,
      type,
      name: tr(locale, "条件过滤", "Filter rows"),
      formula: "TRUE",
    };
  if (type === "formula")
    return {
      ...base,
      type,
      name: tr(locale, "公式计算", "Formula"),
      key: uniqueOutputKey("computed_value", fieldKeys),
      label: tr(locale, "计算值", "Computed value"),
      fieldType: firstNumericField?.type ?? scalarFieldType(firstFormulaField),
      formula: firstNumericField
        ? `ROUND(${firstNumericField.key}, 2)`
        : firstFormulaField
          ? firstFormulaField.key
          : "0",
    };
  if (type === "script")
    return {
      ...base,
      type,
      name: tr(locale, "脚本处理", "Script"),
      key: uniqueOutputKey("script_value", fieldKeys),
      label: tr(locale, "脚本值", "Script value"),
      fieldType: scalarFieldType(firstField),
      source: firstField
        ? `return input[${JSON.stringify(firstField.key)}];`
        : "return null;",
    };
  if (type === "select")
    return {
      ...base,
      type,
      name: tr(locale, "选择字段", "Select fields"),
      fields: fieldKeys,
    };
  if (type === "deduplicate")
    return {
      ...base,
      type,
      name: tr(locale, "数据去重", "Remove duplicates"),
      fields: [],
    };
  if (type === "aggregate")
    return {
      ...base,
      type,
      name: tr(locale, "分组汇总", "Aggregate"),
      groupBy: [],
      field: "",
      operation: "count",
      outputKey: "count",
    };
  if (type === "sort")
    return {
      ...base,
      type,
      name: tr(locale, "字段排序", "Sort rows"),
      field: firstSortField?.key ?? "",
      direction: "desc",
    };
  return {
    ...base,
    type,
    name: tr(locale, "限制数量", "Limit rows"),
    count: 100,
  };
}

function scalarFieldType(field?: DataDatasetField): DataFieldType {
  return field && field.type !== "json" ? field.type : "number";
}

function isFormulaFieldKey(key: string): boolean {
  return /^[A-Za-z_$\p{L}][\w$\p{L}\p{N}]*$/u.test(key);
}

function uniqueOutputKey(preferred: string, existingKeys: string[]): string {
  const occupied = new Set(existingKeys);
  if (!occupied.has(preferred)) return preferred;
  let suffix = 2;
  while (occupied.has(`${preferred}_${suffix}`)) suffix += 1;
  return `${preferred}_${suffix}`;
}

export function normalizeLinearPipeline(
  definition: DataPipelineDefinition,
): DataPipelineDefinition {
  const nodes = definition.nodes.map((node, index) => ({
    ...node,
    position: { x: index * 240, y: 0 },
  }));
  return {
    ...definition,
    nodes,
    edges: nodes
      .slice(1)
      .map((node, index) => ({
        id: definition.edges[index]?.id ?? crypto.randomUUID(),
        sourceNodeId: nodes[index]!.id,
        targetNodeId: node.id,
      })),
  };
}

function nodeIcon(type: DataPipelineNode["type"]): ReactNode {
  if (type === "source") return <Database size={17} />;
  if (type === "filter") return <Filter size={17} />;
  if (type === "formula") return <Calculator size={17} />;
  if (type === "script") return <Code2 size={17} />;
  if (type === "select") return <Columns3 size={17} />;
  if (type === "deduplicate") return <CopyMinus size={17} />;
  if (type === "aggregate") return <Sigma size={17} />;
  if (type === "sort") return <ArrowDownAZ size={17} />;
  if (type === "limit") return <ListEnd size={17} />;
  if (type === "merge") return <GitBranch size={17} />;
  return <Box size={17} />;
}

function nodeTypeLabel(type: DataPipelineNode["type"]): string {
  return {
    source: "DATASET",
    filter: "FILTER",
    formula: "FORMULA",
    script: "QUICKJS",
    select: "SELECT",
    deduplicate: "UNIQUE",
    aggregate: "AGGREGATE",
    sort: "SORT",
    limit: "LIMIT",
    merge: "MERGE",
    output: "OUTPUT",
  }[type];
}

function nodeSummary(node: DataPipelineNode): string {
  if (node.type === "source") return "Dataset";
  if (node.type === "filter") return node.formula;
  if (node.type === "formula" || node.type === "script") return `→ ${node.key}`;
  if (node.type === "select") return `${node.fields.length} fields`;
  if (node.type === "deduplicate") return node.fields.length ? node.fields.join(", ") : "Whole row";
  if (node.type === "aggregate") return `${node.operation.toUpperCase()} → ${node.outputKey}`;
  if (node.type === "sort")
    return `${node.field} · ${node.direction.toUpperCase()}`;
  if (node.type === "limit") return `${node.count} rows`;
  if (node.type === "merge") return "Union";
  return "Data product";
}

function FieldTokenPicker({
  locale,
  label,
  fields,
  selected,
  onChange,
}: {
  locale: AppLocale;
  label: string;
  fields: DataDatasetField[];
  selected: string[];
  onChange: (fields: string[]) => void;
}) {
  return (
    <fieldset className="pipeline-field-picker">
      <legend>{label}</legend>
      {fields.length ? fields.map((field) => {
        const active = selected.includes(field.key);
        return (
          <button
            type="button"
            className={active ? "active" : ""}
            aria-pressed={active}
            key={field.key}
            onClick={() => onChange(active ? selected.filter((key) => key !== field.key) : [...selected, field.key])}
          >
            {field.label || field.key}
            <small>{field.key}</small>
          </button>
        );
      }) : <small>{tr(locale, "先在接入数据中运行查询并同步字段", "Run the dataset query to synchronize fields first")}</small>}
    </fieldset>
  );
}

export function derivePipelineFieldHints(
  nodes: DataPipelineNode[],
  selectedNodeId: string | undefined,
  sourceFields: DataDatasetField[],
): DataDatasetField[] {
  let fields = [...sourceFields];
  for (const node of nodes) {
    if (node.id === selectedNodeId) break;
    if (node.type === "formula" || node.type === "script") {
      fields = [...fields.filter((field) => field.key !== node.key), { key: node.key, label: node.label || node.key, type: node.fieldType }];
    } else if (node.type === "select") {
      fields = fields.filter((field) => node.fields.includes(field.key));
    } else if (node.type === "aggregate") {
      fields = [
        ...fields.filter((field) => node.groupBy.includes(field.key)),
        { key: node.outputKey, label: node.outputKey, type: "number" },
      ];
    }
  }
  return fields;
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
