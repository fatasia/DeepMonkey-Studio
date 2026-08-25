import type {
  ApplicationObjectRef,
  CameraState,
  SpatialNavigationDocument,
  SpatialNavigationNode
} from "@bim-studio/contracts";

export interface SpatialWorkspaceState {
  camera?: CameraState;
  selection?: ApplicationObjectRef[];
  visibilityOverrides?: Record<string, boolean>;
  filters?: Record<string, string | number | boolean | null>;
  activePanel?: string;
  editorTab?: "dashboard" | "scene" | "topology" | "data";
}

export interface SpatialNavigationTransition {
  fromNodeId?: string;
  toNode: SpatialNavigationNode;
  breadcrumb: SpatialNavigationNode[];
  restoreState?: SpatialWorkspaceState;
}

/**
 * Host-independent state for project-defined hierarchical navigation flows.
 * Rendering and asset loading remain host responsibilities; every UI entry point can
 * call this same session so breadcrumbs, Esc and browser history behave identically.
 */
export class SpatialNavigationSession {
  private readonly nodes = new Map<string, SpatialNavigationNode>();
  private readonly stateByNode = new Map<string, SpatialWorkspaceState>();
  private path: string[];

  constructor(private readonly document: SpatialNavigationDocument, initialNodeId?: string) {
    for (const node of document.nodes) {
      if (this.nodes.has(node.id)) throw new Error(`空间导航节点重复：${node.id}`);
      this.nodes.set(node.id, structuredClone(node));
    }
    this.validateTree();
    const initial = initialNodeId ?? document.rootNodeIds[0];
    if (!initial) throw new Error("空间导航至少需要一个根节点");
    this.path = this.resolvePath(initial).map((node) => node.id);
  }

  current(): SpatialNavigationNode {
    return this.requireNode(this.path[this.path.length - 1]);
  }

  breadcrumb(): SpatialNavigationNode[] {
    return this.path.map((id) => structuredClone(this.requireNode(id)));
  }

  canGoBack(): boolean {
    return this.path.length > 1;
  }

  open(nodeId: string, currentState?: SpatialWorkspaceState): SpatialNavigationTransition {
    const fromNodeId = this.path[this.path.length - 1];
    if (fromNodeId && currentState) this.stateByNode.set(fromNodeId, structuredClone(currentState));
    const breadcrumb = this.resolvePath(nodeId);
    this.path = breadcrumb.map((node) => node.id);
    return {
      ...(fromNodeId ? { fromNodeId } : {}),
      toNode: structuredClone(this.requireNode(nodeId)),
      breadcrumb: structuredClone(breadcrumb),
      ...this.restoreStateFor(nodeId)
    };
  }

  back(currentState?: SpatialWorkspaceState): SpatialNavigationTransition | undefined {
    if (!this.canGoBack()) return undefined;
    const fromNodeId = this.path[this.path.length - 1]!;
    if (currentState) this.stateByNode.set(fromNodeId, structuredClone(currentState));
    this.path = this.path.slice(0, -1);
    const nodeId = this.path[this.path.length - 1]!;
    return {
      fromNodeId,
      toNode: structuredClone(this.requireNode(nodeId)),
      breadcrumb: this.breadcrumb(),
      ...this.restoreStateFor(nodeId)
    };
  }

  stateFor(nodeId: string): SpatialWorkspaceState | undefined {
    const state = this.stateByNode.get(nodeId);
    return state ? structuredClone(state) : undefined;
  }

  private restoreStateFor(nodeId: string): Pick<SpatialNavigationTransition, "restoreState"> {
    const restoreState = this.stateByNode.get(nodeId);
    return restoreState ? { restoreState: structuredClone(restoreState) } : {};
  }

  private resolvePath(nodeId: string): SpatialNavigationNode[] {
    const result: SpatialNavigationNode[] = [];
    const visited = new Set<string>();
    let current: SpatialNavigationNode | undefined = this.requireNode(nodeId);
    while (current) {
      if (visited.has(current.id)) throw new Error(`空间导航存在循环：${current.id}`);
      visited.add(current.id);
      result.unshift(current);
      current = current.parentId ? this.requireNode(current.parentId) : undefined;
    }
    if (!this.document.rootNodeIds.includes(result[0]!.id)) {
      throw new Error(`空间导航路径没有声明根节点：${nodeId}`);
    }
    return result;
  }

  private validateTree(): void {
    const rootIds = new Set(this.document.rootNodeIds);
    if (rootIds.size !== this.document.rootNodeIds.length) throw new Error("空间导航根节点不能重复");
    for (const rootId of rootIds) {
      const root = this.requireNode(rootId);
      if (root.parentId) throw new Error(`空间导航根节点不能有父节点：${rootId}`);
    }
    for (const node of this.nodes.values()) {
      if (!node.parentId && !rootIds.has(node.id)) throw new Error(`空间导航孤立根节点未声明：${node.id}`);
      this.resolvePath(node.id);
    }
  }

  private requireNode(nodeId: string | undefined): SpatialNavigationNode {
    if (!nodeId) throw new Error("空间导航节点不能为空");
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`空间导航节点不存在：${nodeId}`);
    return node;
  }
}
