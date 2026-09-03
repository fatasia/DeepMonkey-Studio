import { useState, type DragEvent, type ReactNode } from "react";
import { ArrowDownAZ, Calculator, Code2, Columns3, CopyMinus, Filter, ListEnd, Plus, Sigma } from "lucide-react";
import type { DataPipelineNode, DataPipelineNodeDiagnostic } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { PipelineNodeCard, type TransformNodeType } from "./DataPipelineStudioParts";

const icons: Record<TransformNodeType, ReactNode> = {
  filter: <Filter size={13} />,
  formula: <Calculator size={13} />,
  sort: <ArrowDownAZ size={13} />,
  limit: <ListEnd size={13} />,
  script: <Code2 size={13} />,
  select: <Columns3 size={13} />,
  deduplicate: <CopyMinus size={13} />,
  aggregate: <Sigma size={13} />,
};

export function DataPipelineCanvas({
  locale,
  nodes,
  selectedNodeId,
  diagnostics,
  onSelect,
  onDragStart,
  onDrop,
  onInsert,
}: {
  locale: AppLocale;
  nodes: DataPipelineNode[];
  selectedNodeId?: string | undefined;
  diagnostics: Map<string, DataPipelineNodeDiagnostic>;
  onSelect: (nodeId: string) => void;
  onDragStart: (nodeId: string) => void;
  onDrop: (event: DragEvent, nodeId: string) => void;
  onInsert: (type: TransformNodeType, afterNodeId: string) => void;
}) {
  const [openAfterId, setOpenAfterId] = useState<string>();
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
    <div className="pipeline-canvas" aria-label={tr(locale, "流水线画布", "Pipeline canvas")}>
      {nodes.map((node, index) => {
        const previous = nodes[index - 1];
        return (
          <div className="pipeline-node-wrap" key={node.id}>
            {previous && (
              <div className="pipeline-edge">
                <button
                  className="pipeline-insert-trigger"
                  aria-expanded={openAfterId === previous.id}
                  aria-label={tr(locale, `在“${previous.name}”后插入处理`, `Insert after ${previous.name}`)}
                  title={tr(locale, "在这里插入处理", "Insert transform here")}
                  onClick={() => setOpenAfterId((current) => current === previous.id ? undefined : previous.id)}
                >
                  <Plus size={12} />
                </button>
                {openAfterId === previous.id && (
                  <div className="pipeline-insert-menu">
                    <strong>{tr(locale, "插入处理", "Insert transform")}</strong>
                    {transforms.map(([type, label]) => (
                      <button key={type} onClick={() => {
                        onInsert(type, previous.id);
                        setOpenAfterId(undefined);
                      }}>
                        {icons[type]}
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <PipelineNodeCard
              node={node}
              selected={node.id === selectedNodeId}
              diagnostic={diagnostics.get(node.id)}
              draggable={node.type !== "source" && node.type !== "output"}
              onDragStart={() => onDragStart(node.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, node.id)}
              onSelect={() => onSelect(node.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
