import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Box as BoxIcon, ListTree, Search, TriangleAlert } from "lucide-react";
import type { ModelRecord, ModelStructureNode, ModelStructurePropertiesResponse, ModelStructureResponse } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { createModelStructureApi } from "../apiClients/modelStructureApi";
import "./ModelStructureTreePanel.css";

/** 装配结构树面板：消费转换 sidecar（hierarchy.json / properties.json）的只读视图。
 *  大装配不靠整棵渲染：固定行高 + 滚动窗口只绘制可见行，过滤时沿匹配路径自动展开。 */

const ROW_HEIGHT = 26;
const VISIBLE_ROWS = 12;
const OVERSCAN = 6;
const PROPERTY_MESH_LIMIT = 8;

export type StructureRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface StructureRow {
  node: ModelStructureNode;
  depth: number;
  expanded: boolean;
  selfMatch: boolean;
}

export type StructureLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ModelStructureResponse };

export interface StructurePropertyGroup {
  title: string;
  rows: Array<[string, string]>;
}

export type PropertiesLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; groups: StructurePropertyGroup[]; partialNote?: string };

/** 状态语义：有结构即可用；waiting_converter 若已产出 sidecar 仍可读（附提示），否则按任务状态给出禁用原因。 */
export function structureAvailability(model: ModelRecord, locale: AppLocale): { available: true; hint?: string } | { available: false; reason: string } {
  if (model.manifest?.hierarchyUrl) {
    const hint = model.status === "waiting_converter"
      ? tr(locale, "结构已读取；该格式尚未发布可视化几何", "Structure parsed; no viewable geometry published yet")
      : model.status === "failed"
        ? tr(locale, "结构可用；但转换最终失败", "Structure available; the conversion ultimately failed")
        : undefined;
    return hint ? { available: true, hint } : { available: true };
  }
  if (model.status === "queued" || model.status === "processing") {
    return { available: false, reason: tr(locale, "模型仍在转换中，装配结构在转换完成后可用", "Conversion in progress; the assembly structure becomes available once it finishes") };
  }
  if (model.status === "waiting_converter") {
    return { available: false, reason: tr(locale, "当前转换器尚未为该文件发布结构数据", "The converter has not published structure data for this file") };
  }
  if (model.status === "failed") {
    return { available: false, reason: tr(locale, "转换失败，未生成装配结构", "Conversion failed; no assembly structure was produced") };
  }
  return { available: false, reason: tr(locale, "该格式未生成装配结构数据", "This format has no assembly structure data") };
}

interface MatchInfo { selfMatch: boolean; subtreeMatch: boolean; childMatch: boolean }

/** 展开态 + 搜索词 → 可见行序列。过滤时沿匹配路径自动展开；无过滤时遵循展开集合。 */
export function flattenStructure(root: ModelStructureNode, options: { expanded: ReadonlySet<string>; query: string }): StructureRow[] {
  const query = options.query.trim().toLowerCase();
  const matches = new Map<string, MatchInfo>();
  const evaluate = (node: ModelStructureNode): MatchInfo => {
    const selfMatch = !query
      || node.name.toLowerCase().includes(query)
      || (node.type ?? "").toLowerCase().includes(query);
    const children = node.children.map(evaluate);
    const childMatch = children.some((child) => child.subtreeMatch);
    const info: MatchInfo = { selfMatch, childMatch, subtreeMatch: selfMatch || childMatch };
    matches.set(node.id, info);
    return info;
  };
  evaluate(root);
  const rows: StructureRow[] = [];
  const visit = (node: ModelStructureNode, depth: number): void => {
    const info = matches.get(node.id);
    if (!info?.subtreeMatch) return;
    const expanded = query ? info.childMatch : options.expanded.has(node.id);
    rows.push({ node, depth, expanded, selfMatch: info.selfMatch });
    if (expanded) for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return rows;
}

export function findStructureNode(root: ModelStructureNode, id: string): ModelStructureNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findStructureNode(child, id);
    if (found) return found;
  }
  return undefined;
}

/** 属性查询 id 清单：节点自身 + 网格样本，受服务端单次 16 个上限约束。 */
export function propertyRequestIds(node: ModelStructureNode): string[] {
  return [node.id, ...(node.meshSampleIds ?? [])].slice(0, 2 * PROPERTY_MESH_LIMIT);
}

function toPropertyGroups(
  node: ModelStructureNode,
  result: ModelStructurePropertiesResponse,
  locale: AppLocale,
): { groups: StructurePropertyGroup[]; partialNote?: string } {
  const groups: StructurePropertyGroup[] = [];
  const nodeEntry = result.elements[node.id];
  if (nodeEntry && Object.keys(nodeEntry.displayProperties).length) {
    groups.push({ title: tr(locale, "节点属性", "Node properties"), rows: Object.entries(nodeEntry.displayProperties) });
  }
  const samples = node.meshSampleIds ?? [];
  samples.forEach((meshId, index) => {
    const entry = result.elements[meshId];
    if (!entry || !Object.keys(entry.displayProperties).length) return;
    const label = entry.displayProperties["名称"] ?? `#${index + 1}`;
    groups.push({ title: tr(locale, `网格 · ${label}`, `Mesh · ${label}`), rows: Object.entries(entry.displayProperties) });
  });
  const partialNote = node.meshCount > samples.length
    ? tr(
      locale,
      `该节点共 ${node.meshCount.toLocaleString("zh-CN")} 个网格，属性仅展示前 ${samples.length} 个`,
      `This node has ${node.meshCount.toLocaleString("en-US")} meshes; showing the first ${samples.length}`,
    )
    : undefined;
  return partialNote ? { groups, partialNote } : { groups };
}

export function ModelStructureTreePanel({ model, locale, request }: {
  model: ModelRecord;
  locale: AppLocale;
  /** 注入的传输通道（raw fetch 只允许在 api.ts；面板只持有此函数）。 */
  request: StructureRequest;
}) {
  const [structure, setStructure] = useState<StructureLoad>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectedId, setSelectedId] = useState<string>();
  const [properties, setProperties] = useState<PropertiesLoad>({ status: "idle" });
  const [scrollTop, setScrollTop] = useState(0);
  const availability = structureAvailability(model, locale);
  const api = createModelStructureApi(request);

  useEffect(() => {
    if (!availability.available) return;
    const controller = new AbortController();
    setStructure({ status: "loading" });
    api.getModelStructure(model.projectId, model.id, controller.signal)
      .then((data) => {
        setStructure({ status: "ready", data });
        setExpanded(new Set([data.root.id]));
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setStructure({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.projectId, model.id, model.manifest?.hierarchyUrl]);

  useEffect(() => {
    if (structure.status !== "ready" || !selectedId) return;
    const node = findStructureNode(structure.data.root, selectedId);
    if (!node) return;
    const controller = new AbortController();
    setProperties({ status: "loading" });
    api.getModelStructureProperties(model.projectId, model.id, propertyRequestIds(node), controller.signal)
      .then((result) => {
        const { groups, partialNote } = toPropertyGroups(node, result, locale);
        setProperties(partialNote ? { status: "ready", groups, partialNote } : { status: "ready", groups });
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setProperties({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, structure, model.projectId, model.id]);

  if (!availability.available) {
    return (
      <section className="model-structure-panel" aria-label={tr(locale, "装配结构", "Assembly structure")}>
        <h3><ListTree size={15} />{tr(locale, "装配结构", "Assembly structure")}</h3>
        <div className="model-structure-notice" role="note">
          <TriangleAlert size={14} aria-hidden />
          <div>
            <strong>{availability.reason}</strong>
            {model.message && <small>{model.message}</small>}
          </div>
        </div>
      </section>
    );
  }

  const rows = structure.status === "ready" ? flattenStructure(structure.data.root, { expanded, query }) : [];
  const matchCount = rows.filter((row) => row.selfMatch).length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, start + VISIBLE_ROWS + OVERSCAN * 2);
  const selected = structure.status === "ready" && selectedId ? findStructureNode(structure.data.root, selectedId) : undefined;
  const depthSize = 14;

  return (
    <section className="model-structure-panel" aria-label={tr(locale, "装配结构", "Assembly structure")}>
      <h3><ListTree size={15} />{tr(locale, "装配结构", "Assembly structure")}</h3>
      {availability.hint && <p className="model-structure-hint" role="note">{availability.hint}</p>}
      {structure.status === "loading" && <p className="model-structure-muted" role="status">{tr(locale, "正在读取装配结构…", "Reading assembly structure…")}</p>}
      {structure.status === "error" && <p className="model-structure-error" role="alert">{tr(locale, "装配结构读取失败：", "Failed to read assembly structure: ")}{structure.message}</p>}
      {structure.status === "ready" && (
        <>
          <div className="model-structure-toolbar">
            <label className="model-structure-search">
              <Search size={13} aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr(locale, "搜索名称或类型", "Search name or type")}
                aria-label={tr(locale, "搜索装配节点", "Search assembly nodes")}
              />
            </label>
            <span className="model-structure-meta" role="status">
              {query.trim()
                ? tr(locale, `${matchCount.toLocaleString("zh-CN")} / ${structure.data.nodeCount.toLocaleString("zh-CN")} 节点匹配`, `${matchCount.toLocaleString("en-US")} of ${structure.data.nodeCount.toLocaleString("en-US")} nodes match`)
                : tr(locale, `${structure.data.nodeCount.toLocaleString("zh-CN")} 节点`, `${structure.data.nodeCount.toLocaleString("en-US")} nodes`)}
              {structure.data.truncated && <em title={tr(locale, "超过服务端节点上限，深层子树未展开", "Server node limit exceeded; deeper subtrees are not expanded")}>{tr(locale, "已截断", "truncated")}</em>}
            </span>
          </div>
          <div className="model-structure-layout">
            {rows.length === 0
              ? <div className="model-structure-empty" role="status">{tr(locale, "没有匹配的节点", "No matching nodes")}</div>
              : (
                <div
                  className="model-structure-tree"
                  role="tree"
                  aria-label={tr(locale, "装配层级", "Assembly hierarchy")}
                  onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                >
                  <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
                    <div style={{ position: "absolute", top: start * ROW_HEIGHT, left: 0, right: 0 }}>
                      {rows.slice(start, end).map((row) => {
                        const hasChildren = row.node.children.length > 0;
                        const isSelected = row.node.id === selectedId;
                        return (
                          <div
                            key={row.node.id}
                            role="treeitem"
                            aria-level={row.depth + 1}
                            aria-selected={isSelected}
                            aria-expanded={hasChildren ? row.expanded : undefined}
                            className={`model-structure-row${isSelected ? " is-selected" : ""}`}
                            style={{ height: ROW_HEIGHT }}
                          >
                            <span style={{ width: row.depth * depthSize }} aria-hidden />
                            {hasChildren
                              ? (
                                <button
                                  type="button"
                                  className="model-structure-toggle"
                                  aria-label={tr(locale, row.expanded ? `折叠 ${row.node.name}` : `展开 ${row.node.name}`, row.expanded ? `Collapse ${row.node.name}` : `Expand ${row.node.name}`)}
                                  onClick={() => {
                                    const next = new Set(expanded);
                                    if (next.has(row.node.id)) next.delete(row.node.id);
                                    else next.add(row.node.id);
                                    setExpanded(next);
                                  }}
                                >
                                  {row.expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                                </button>
                              )
                              : <span className="model-structure-leaf" aria-hidden><BoxIcon size={12} /></span>}
                            <button
                              type="button"
                              className="model-structure-select"
                              onClick={() => setSelectedId(row.node.id)}
                            >
                              <span className={`model-structure-name${row.selfMatch && query.trim() ? " is-match" : ""}`}>{row.node.name}</span>
                              {row.node.type && <span className="model-structure-type">{row.node.type}</span>}
                              {row.node.meshCount > 0 && <span className="model-structure-count" title={tr(locale, "直属网格数", "Direct mesh count")}>{row.node.meshCount.toLocaleString(locale)}</span>}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            <aside className="model-structure-properties" aria-label={tr(locale, "节点属性", "Node properties")}>
              {selected
                ? <h4 title={selected.name}>{selected.name}</h4>
                : <h4>{tr(locale, "节点属性", "Node properties")}</h4>}
              {!selected && <p className="model-structure-muted">{tr(locale, "选择一个节点查看属性", "Select a node to inspect its properties")}</p>}
              {selected && properties.status === "loading" && <p className="model-structure-muted" role="status">{tr(locale, "正在读取属性…", "Reading properties…")}</p>}
              {selected && properties.status === "error" && <p className="model-structure-error" role="alert">{tr(locale, "属性读取失败：", "Failed to read properties: ")}{properties.message}</p>}
              {selected && properties.status === "ready" && properties.groups.length === 0 && (
                <p className="model-structure-muted">{tr(locale, "该节点没有属性记录", "This node has no property record")}</p>
              )}
              {selected && properties.status === "ready" && properties.groups.map((group, groupIndex) => (
                <section key={`${groupIndex}-${group.title}`} className="model-structure-property-group">
                  <h5>{group.title}</h5>
                  <table>
                    <tbody>
                      {group.rows.map(([key, value]) => (
                        <tr key={key}><th scope="row">{key}</th><td>{value}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
              {selected && properties.status === "ready" && properties.partialNote && (
                <p className="model-structure-muted">{properties.partialNote}</p>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
