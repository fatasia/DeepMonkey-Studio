import * as THREE from "three";

// P1 模型版本变更对比·切片二：diff 结果的三色场景表达。
// 只读 overlay：透明 + 自发光材质覆盖，恢复原材质；复用碰撞高亮的存取模式，
// 不新建渲染系统，也不进入 layerStates（不会写入场景保存状态）。

export type DiffHighlightKind = "added" | "removed" | "modified";

/** 三色语义与设计令牌的唯一映射；新增=成功绿、删除=危险红、修改=警示黄。 */
export const DIFF_HIGHLIGHT_TOKENS: Record<DiffHighlightKind, string> = {
  added: "--success",
  removed: "--danger",
  modified: "--warning",
};

/**
 * 令牌 → 场景色。base.css 的语义令牌在 :root 与浅色主题各有一份，
 * 每次应用前重新解析即可跟随主题切换。令牌缺失时回退中性灰（非语义色），
 * 由调用方在证据中如实声明，不硬编码语义色值。
 */
export function resolveDiffHighlightColors(read: (token: string) => string): Record<DiffHighlightKind, THREE.Color> {
  const parse = (token: string) => {
    const value = read(token).trim();
    return value ? new THREE.Color(value) : new THREE.Color("#7f8c99");
  };
  return {
    added: parse(DIFF_HIGHLIGHT_TOKENS.added),
    removed: parse(DIFF_HIGHLIGHT_TOKENS.removed),
    modified: parse(DIFF_HIGHLIGHT_TOKENS.modified),
  };
}

export interface DiffHighlightObjectTarget {
  object: THREE.Object3D;
  kind: DiffHighlightKind;
}

interface OverlayEntry {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
}

/**
 * 构件级材质覆盖。与碰撞高亮各自的存取表互不感知；两者同时作用于同一网格时，
 * 后应用者保存的是前者的覆盖材质——评审场景下碰撞高亮是瞬态指针反馈，边界已在证据中声明。
 */
export class ModelDiffOverlay {
  private readonly applied = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private materials: Record<DiffHighlightKind, THREE.Material> | undefined;

  get activeCount(): number {
    return this.applied.size;
  }

  apply(targets: DiffHighlightObjectTarget[], colors: Record<DiffHighlightKind, THREE.Color>): void {
    this.clear();
    if (targets.length === 0) return;
    this.materials = {
      added: createOverlayMaterial(colors.added),
      removed: createOverlayMaterial(colors.removed),
      modified: createOverlayMaterial(colors.modified),
    };
    const seen = new Set<THREE.Mesh>();
    for (const { object, kind } of targets) {
      const material = this.materials[kind];
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material || seen.has(mesh)) return;
        seen.add(mesh);
        this.applied.set(mesh, mesh.material);
        mesh.material = material;
      });
    }
  }

  clear(): void {
    for (const [mesh, original] of this.applied) {
      // 网格可能已被其它能力替换材质；只回滚仍然挂着 overlay 材质的网格。
      if (isCurrentOverlay(mesh.material, this.materials)) mesh.material = original;
    }
    this.applied.clear();
    for (const material of Object.values(this.materials ?? {})) material.dispose();
    this.materials = undefined;
  }
}

function createOverlayMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: color.clone(),
    emissive: color.clone(),
    emissiveIntensity: 0.85,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    roughness: 0.4,
    metalness: 0,
  });
}

function isCurrentOverlay(
  current: THREE.Material | THREE.Material[] | undefined,
  materials: Record<DiffHighlightKind, THREE.Material> | undefined,
): boolean {
  if (!materials || !current) return false;
  const values = Object.values(materials);
  return (Array.isArray(current) ? current : [current]).some((material) => values.includes(material));
}
