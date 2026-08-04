import { useEffect, useState } from "react";
import { Box, ChevronDown, ChevronRight, Eye, EyeOff, Group, Lock, Trash2, Unlock } from "lucide-react";
import type { LayerTreeNode } from "../viewer/ViewerEngine";

interface LayerTreeProps {
  root: LayerTreeNode;
  selectedNodeId: string | undefined;
  onSelect: (node: LayerTreeNode) => void;
  onVisibilityChange: (node: LayerTreeNode, visible: boolean) => void;
  onLockChange: (node: LayerTreeNode, locked: boolean) => void;
  onDelete: (node: LayerTreeNode) => void;
}

export function LayerTree({ root, selectedNodeId, onSelect, onVisibilityChange, onLockChange, onDelete }: LayerTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.id]));

  useEffect(() => {
    setExpanded(new Set([root.id]));
  }, [root.modelId]);

  function toggle(nodeId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  return (
    <div className="layer-tree">
      <LayerNode
        node={root}
        depth={0}
        expanded={expanded}
        selectedNodeId={selectedNodeId}
        onToggle={toggle}
        onSelect={onSelect}
        onVisibilityChange={onVisibilityChange}
        onLockChange={onLockChange}
        onDelete={onDelete}
      />
    </div>
  );
}

interface LayerNodeProps {
  node: LayerTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedNodeId: string | undefined;
  onToggle: (nodeId: string) => void;
  onSelect: (node: LayerTreeNode) => void;
  onVisibilityChange: (node: LayerTreeNode, visible: boolean) => void;
  onLockChange: (node: LayerTreeNode, locked: boolean) => void;
  onDelete: (node: LayerTreeNode) => void;
}

function LayerNode({
  node,
  depth,
  expanded,
  selectedNodeId,
  onToggle,
  onSelect,
  onVisibilityChange,
  onLockChange,
  onDelete
}: LayerNodeProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  return (
    <>
      <div
        className={`layer-node ${selectedNodeId === node.id ? "selected" : ""}`}
        style={{ paddingLeft: `${8 + depth * 15}px` }}
      >
        <button
          className="tree-expander"
          aria-label={isExpanded ? "收起" : "展开"}
          disabled={!hasChildren}
          onClick={() => hasChildren && onToggle(node.id)}
        >
          {hasChildren ? isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span />}
        </button>
        <button className="layer-node-main" title={node.name} onClick={() => onSelect(node)}>
          {hasChildren ? <Group size={13} /> : <Box size={12} />}
          <span>{node.name}</span>
          {hasChildren && <small>{node.children.length}</small>}
        </button>
        <button
          className="tree-visibility"
          title={node.visible ? "隐藏该层" : "显示该层"}
          onClick={() => onVisibilityChange(node, !node.visible)}
        >
          {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button className={`tree-lock ${node.locked ? "active" : ""}`} title={node.locked ? "解锁该层" : "锁定该层"} onClick={() => onLockChange(node, !node.locked)}>
          {node.locked ? <Lock size={12} /> : <Unlock size={12} />}
        </button>
        {depth > 0 && (
          <button className="tree-delete" disabled={node.locked} title={node.locked ? "请先解锁该层" : "从当前场景删除该层"} onClick={() => onDelete(node)}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {hasChildren && isExpanded && node.children.map((child) => (
        <LayerNode
          key={child.id}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          selectedNodeId={selectedNodeId}
          onToggle={onToggle}
          onSelect={onSelect}
          onVisibilityChange={onVisibilityChange}
          onLockChange={onLockChange}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}
