import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { DataPipelineNode, DataPipelineNodeDiagnostic } from "@bim-studio/contracts";
import { CheckCircle2, XCircle } from "lucide-react";
import { nodeIcon, nodeSummary, nodeTypeLabel } from "./DataPipelineStudioParts";

export type PipelineFlowNode = Node<{ definition: DataPipelineNode; diagnostic?: DataPipelineNodeDiagnostic | undefined }, "pipeline">;
export const DataPipelineGraphNode = memo(function DataPipelineGraphNode({ data, selected }: NodeProps<PipelineFlowNode>) {
  const node = data.definition, diagnostic = data.diagnostic;
  return <div className={`pipeline-node ${selected ? "selected" : ""} ${diagnostic?.status ?? ""}`}>
    {node.type !== "source" && <Handle type="target" position={Position.Left} id="input"
      aria-label={`${node.name} 输入`} />}
    <span className="pipeline-node-icon">{nodeIcon(node.type)}</span>
    <span className="pipeline-node-copy"><small>{nodeTypeLabel(node.type)}</small>
      <strong title={node.name}>{node.name}</strong><em title={nodeSummary(node)}>{nodeSummary(node)}</em></span>
    {diagnostic && <b title={`${diagnostic.inputRows} → ${diagnostic.outputRows} · ${diagnostic.durationMs.toFixed(1)}ms`}>
      {diagnostic.status === "success" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}</b>}
    {node.type !== "output" && <Handle type="source" position={Position.Right} id="output"
      aria-label={`${node.name} 输出`} />}
  </div>;
});
