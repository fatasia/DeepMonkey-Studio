import type { TopologyDocument } from "@bim-studio/contracts";
import { topologyNodeLabel } from "@bim-studio/studio-core";

/** 预览读取真实节点和关系，不以随机装饰点替代项目内容。 */
export function TopologyMiniature({ topology }: { topology: TopologyDocument }) {
  const nodes = topology.nodes.slice(0, 250);
  if (!nodes.length) return <svg viewBox="0 0 320 148" aria-hidden="true" className="topology-miniature"><rect x="142" y="60" width="36" height="28" rx="6" className="topology-miniature__empty" /></svg>;
  const xs = nodes.map(node => node.x), ys = nodes.map(node => node.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const rangeX = Math.max(...xs) - minX, rangeY = Math.max(...ys) - minY;
  const scale = Math.min(264 / Math.max(1, rangeX), 92 / Math.max(1, rangeY));
  const positions = new Map(nodes.map(node => [node.id, {
    x: 160 + (node.x - minX - rangeX / 2) * scale,
    y: 68 + (node.y - minY - rangeY / 2) * scale,
  }]));
  return <svg viewBox="0 0 320 148" aria-hidden="true" className="topology-miniature">
    {topology.edges.slice(0, 500).map(edge => {
      const source = positions.get(edge.sourceNodeId), target = positions.get(edge.targetNodeId);
      return source && target ? <path key={edge.id} data-edge={edge.id} d={`M${source.x},${source.y} L${target.x},${target.y}`} className="topology-miniature__edge" /> : null;
    })}
    {nodes.map(node => {
      const point = positions.get(node.id)!;
      const label = topologyNodeLabel(node);
      const crowded = nodes.some(other => {
        const neighbor = positions.get(other.id)!;
        return other.id !== node.id && Math.abs(point.x - neighbor.x) < 60 && Math.abs(point.y - neighbor.y) < 32;
      });
      return <g key={node.id} data-node={node.id} transform={`translate(${point.x},${point.y})`}>
        <title>{label}</title>
        <rect x="-9" y="-7" width="18" height="14" rx={node.kind === "source" || node.kind === "sink" ? 7 : 3} className="topology-miniature__node" />
        {nodes.length <= 12 && !crowded && <text y="22" textAnchor="middle">{Array.from(label).slice(0, 8).join("")}</text>}
      </g>;
    })}
    {(topology.nodes.length > 250 || topology.edges.length > 500) && <text x="12" y="141">250 nodes / 500 edges max</text>}
  </svg>;
}
