import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownAZ,
  Calculator,
  Code2,
  Columns3,
  CopyMinus,
  Filter,
  GitBranch,
  ListEnd,
  Plus,
  Search,
  Trash2,
  Sigma,
} from "lucide-react";
import type { DataPipelineDefinition } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { TransformNodeType } from "./DataPipelineStudioParts";

const transformIcons: Record<TransformNodeType, ReactNode> = {
  filter: <Filter size={14} />,
  formula: <Calculator size={14} />,
  script: <Code2 size={14} />,
  select: <Columns3 size={14} />,
  deduplicate: <CopyMinus size={14} />,
  aggregate: <Sigma size={14} />,
  sort: <ArrowDownAZ size={14} />,
  limit: <ListEnd size={14} />,
};

export function DataPipelineLibrary({
  locale,
  pipelines,
  activeId,
  canCreate,
  canInsert,
  loading,
  onCreate,
  onSelect,
  onRemove,
  onInsert,
}: {
  locale: AppLocale;
  pipelines: DataPipelineDefinition[];
  activeId?: string | undefined;
  canCreate: boolean;
  canInsert: boolean;
  loading: boolean;
  onCreate: () => void;
  onSelect: (pipeline: DataPipelineDefinition) => void;
  onRemove: (pipeline: DataPipelineDefinition) => void;
  onInsert: (type: TransformNodeType) => void;
}) {
  const [query, setQuery] = useState("");
  const visiblePipelines = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return keyword
      ? pipelines.filter((pipeline) => pipeline.name.toLocaleLowerCase().includes(keyword))
      : pipelines;
  }, [pipelines, query]);
  const transforms: Array<[TransformNodeType, string]> = [
    ["filter", tr(locale, "过滤", "Filter")],
    ["formula", tr(locale, "公式", "Formula")],
    ["select", tr(locale, "选字段", "Select")],
    ["deduplicate", tr(locale, "去重", "Deduplicate")],
    ["aggregate", tr(locale, "汇总", "Aggregate")],
    ["sort", tr(locale, "排序", "Sort")],
    ["limit", tr(locale, "限量", "Limit")],
    ["script", tr(locale, "脚本", "Script")],
  ];

  return (
    <aside className="pipeline-library">
      <header>
        <span>
          <strong>{tr(locale, "处理流程", "Pipelines")}</strong>
          <small>{loading ? tr(locale, "加载中", "Loading") : `${pipelines.length} ${tr(locale, "个流程", "flows")}`}</small>
        </span>
        <button disabled={loading || !canCreate} onClick={onCreate}>
          <Plus size={14} />
          {tr(locale, "新建", "New")}
        </button>
      </header>
      <label className="pipeline-search">
        <Search size={13} />
        <input
          aria-label={tr(locale, "搜索流程", "Search pipelines")}
          value={query}
          placeholder={tr(locale, "搜索流程", "Search pipelines")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="pipeline-list">
        {visiblePipelines.map((pipeline) => (
          <article className={activeId === pipeline.id ? "active" : ""} key={pipeline.id}>
            <button onClick={() => onSelect(pipeline)}>
              <GitBranch size={16} />
              <span>
                <strong>{pipeline.name}</strong>
                <small>
                  {pipeline.nodes.length} {tr(locale, "个节点", "nodes")}
                  {activeId === pipeline.id ? ` · ${tr(locale, "正在编辑", "Editing")}` : ""}
                </small>
              </span>
            </button>
            <button className="icon danger" title={tr(locale, "删除", "Delete")} onClick={() => onRemove(pipeline)}>
              <Trash2 size={13} />
            </button>
          </article>
        ))}
        {query && !visiblePipelines.length && (
          <div className="pipeline-list-empty">{tr(locale, "没有匹配的流程", "No matching pipelines")}</div>
        )}
      </div>
      <section className="pipeline-palette">
        <header>
          <strong>{tr(locale, "处理模块", "Transforms")}</strong>
          <small>{tr(locale, "插入到当前节点之后", "Insert after selected node")}</small>
        </header>
        <div>
          {transforms.map(([type, label]) => (
            <button key={type} disabled={!canInsert} title={label} onClick={() => onInsert(type)}>
              {transformIcons[type]}
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
