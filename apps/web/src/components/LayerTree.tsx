import { useEffect, useState } from "react";
import { Box, ChevronDown, ChevronRight, Eye, EyeOff, Group, Lock, Trash2, Unlock } from "lucide-react";
import type { LayerTreeNode } from "../viewer/ViewerEngine";
import { translate as tr, type AppLocale } from "../i18n";

interface LayerTreeProps {
  root: LayerTreeNode;
  locale: AppLocale;
  selectedNodeId: string | undefined;
  onSelect: (node: LayerTreeNode) => void;
  onVisibilityChange: (node: LayerTreeNode, visible: boolean) => void;
  onLockChange: (node: LayerTreeNode, locked: boolean) => void;
  onDelete: (node: LayerTreeNode) => void;
}

export function LayerTree({ root, locale, selectedNodeId, onSelect, onVisibilityChange, onLockChange, onDelete }: LayerTreeProps) {
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
        locale={locale}
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
  locale: AppLocale;
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
  locale,
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
          aria-label={isExpanded ? tr(locale, "收起", "Collapse") : tr(locale, "展开", "Expand")}
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
          aria-label={node.visible ? tr(locale, "隐藏该层", "Hide layer") : tr(locale, "显示该层", "Show layer")}
          title={node.visible ? tr(locale, "隐藏该层", "Hide layer") : tr(locale, "显示该层", "Show layer")}
          onClick={() => onVisibilityChange(node, !node.visible)}
        >
          {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button className={`tree-lock ${node.locked ? "active" : ""}`} aria-label={node.locked ? tr(locale, "解锁该层", "Unlock layer") : tr(locale, "锁定该层", "Lock layer")} title={node.locked ? tr(locale, "解锁该层", "Unlock layer") : tr(locale, "锁定该层", "Lock layer")} onClick={() => onLockChange(node, !node.locked)}>
          {node.locked ? <Lock size={12} /> : <Unlock size={12} />}
        </button>
        {depth > 0 && (
          <button className="tree-delete" disabled={node.locked} aria-label={node.locked ? tr(locale, "请先解锁该层", "Unlock the layer first") : tr(locale, "从当前场景删除该层", "Delete layer from scene")} title={node.locked ? tr(locale, "请先解锁该层", "Unlock the layer first") : tr(locale, "从当前场景删除该层", "Delete layer from scene")} onClick={() => onDelete(node)}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {hasChildren && isExpanded && node.children.map((child) => (
        <LayerNode
          key={child.id}
          node={child}
          locale={locale}
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
