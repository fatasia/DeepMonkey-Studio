import type * as THREE from "three";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { captureAuthorSkinPalette } from "@bim-studio/deep-engine/three-bridge";

type Pose = NonNullable<RenderPacket["deformation"]>["poses"][number];

interface PoseSyncHost {
  listModels(): readonly { readonly id: string; readonly object: THREE.Object3D }[];
}

/** 驱动 Deep 变形姿态的目标后端:只需要"替换姿态"这一个能力。 */
export interface PoseSyncTarget {
  updateDeformationPoses(poses: readonly Pose[]): void;
}

interface Binding {
  readonly root: THREE.Object3D;
  readonly mesh: THREE.Object3D;
  readonly skinned: boolean;
  readonly morphTargets: number;
  readonly poseIndex: number;
  current: Pose;
}

export interface PoseSyncDiagnostics {
  readonly bound: number;
  /** 无法与 Three 对象一一对应(数量/顶点数/骨骼数不符)的模型 → 保持绑定姿态。 */
  readonly unmatched: readonly { readonly modelId: string; readonly reason: string }[];
}

/**
 * 独立 RenderPacket 路径下的蒙皮/形变姿态同步:Three AnimationMixer 仍是姿态的唯一作者,
 * 每帧把 SkinnedMesh 骨骼调色板与 morphTargetInfluences 读成 Deep 姿态。
 * 包内的变形实例与 Three 的变形网格按"模型内先序遍历顺序"配对(两者都来自同一 glTF 场景遍历),
 * 并用顶点数/骨骼数/形变目标数校验;校验失败的模型保持绑定姿态而不是错位绘制。
 */
export class StudioDeformationPoseSync {
  readonly diagnostics: PoseSyncDiagnostics;
  private readonly roots: readonly THREE.Object3D[];

  private constructor(private readonly bindings: Binding[], diagnostics: PoseSyncDiagnostics, private readonly allPoses: Pose[]) {
    this.diagnostics = diagnostics;
    this.roots = [...new Set(bindings.map(binding => binding.root))];
  }

  static create(packet: RenderPacket, host: PoseSyncHost): StudioDeformationPoseSync | undefined {
    const deformation = packet.deformation;
    if (!deformation?.poses.length) return undefined;
    const instances = new Map(packet.instances.map(instance => [instance.id, instance]));
    const geometries = new Map(packet.geometries.map(geometry => [geometry.id, geometry]));
    const sources = new Map(deformation.sources.map(source => [source.id, source]));
    const poses = new Map(deformation.poses.map((pose, index) => [pose.id, { pose, index }]));
    const objects = new Map(host.listModels().map(model => [model.id, model.object]));
    const bindings: Binding[] = [], unmatched: { modelId: string; reason: string }[] = [];
    for (const binding of packet.objectBindings ?? []) {
      const posed = binding.instanceIds.flatMap(id => { const instance = instances.get(id); return instance?.pose === undefined ? [] : [instance]; });
      if (!posed.length) continue;
      const root = objects.get(binding.nodeId);
      if (!root) { unmatched.push({ modelId: binding.nodeId, reason: "Three 模型对象不可用" }); continue; }
      const meshes: THREE.Object3D[] = [];
      root.traverse(object => {
        const mesh = object as THREE.SkinnedMesh;
        if (mesh.isMesh === true && (mesh.isSkinnedMesh === true || (mesh.morphTargetInfluences?.length ?? 0) > 0)) meshes.push(mesh);
      });
      if (meshes.length !== posed.length) {
        unmatched.push({ modelId: binding.nodeId, reason: `变形网格数量不一致：包 ${posed.length} / Three ${meshes.length}` });
        continue;
      }
      const paired: Binding[] = [];
      let reason: string | undefined;
      for (let index = 0; index < posed.length && !reason; index++) {
        const instance = posed[index]!, mesh = meshes[index] as THREE.SkinnedMesh;
        const entry = poses.get(instance.pose!), pose = entry?.pose, source = pose ? sources.get(pose.source) : undefined, geometry = geometries.get(instance.geometry);
        if (!pose || !source || !geometry) { reason = `变形姿态缺失：${instance.id}`; break; }
        const vertices = geometry.vertices.length / 6, authored = mesh.geometry?.attributes?.position?.count;
        if (vertices !== authored) { reason = `顶点数不一致：包 ${vertices} / Three ${String(authored)}`; break; }
        const skinned = source.skinning !== undefined, morphTargets = source.morph?.primitive.targets.length ?? 0;
        if (skinned !== (mesh.isSkinnedMesh === true)) { reason = "蒙皮类型不一致"; break; }
        if (skinned && (pose.palette?.matrices.length ?? 0) !== (mesh.skeleton?.bones.length ?? 0) * 16) { reason = "骨骼数不一致"; break; }
        if (morphTargets !== (mesh.morphTargetInfluences?.length ?? 0)) { reason = "形变目标数不一致"; break; }
        paired.push({ root, mesh, skinned, morphTargets, poseIndex: entry!.index, current: pose });
      }
      if (reason) unmatched.push({ modelId: binding.nodeId, reason });
      else bindings.push(...paired);
    }
    if (!bindings.length && !unmatched.length) return undefined;
    // 未配对模型的姿态保持包内绑定姿态;已配对姿态在 apply 中原地替换。
    return new StudioDeformationPoseSync(bindings, { bound: bindings.length, unmatched }, deformation.poses.slice());
  }

  /** A fresh author asset starts at revision zero; a replacement still shares the live GPU pose IDs. */
  prepareReplacement(packet: RenderPacket, host: PoseSyncHost): RenderPacket {
    if (!packet.deformation) return packet;
    const live = new Map(this.allPoses.map(pose => [pose.id, pose]));
    const poses = packet.deformation.poses.map(pose => {
      const previous = live.get(pose.id);
      if (!previous || previous.source !== pose.source) return pose;
      return { ...pose, revision: Math.max(pose.revision, previous.revision + 1),
        ...(pose.palette ? { palette: { ...pose.palette,
          revision: Math.max(pose.palette.revision, (previous.palette?.revision ?? -1) + 1) } } : {}),
        ...(pose.morphWeights ? { morphWeights: { ...pose.morphWeights,
          revision: Math.max(pose.morphWeights.revision, (previous.morphWeights?.revision ?? -1) + 1) } } : {}) };
    });
    let candidate: RenderPacket = { ...packet, deformation: { ...packet.deformation, poses } };
    const reader = StudioDeformationPoseSync.create(candidate, host);
    reader?.apply({ updateDeformationPoses: current => {
      candidate = { ...candidate, deformation: { ...candidate.deformation!, poses: current.slice() } };
    } });
    return candidate;
  }

  /** 读取 Three 当前姿态并推送给 Deep;姿态未变化时不上传,返回是否发生变化。 */
  apply(target: PoseSyncTarget): boolean {
    if (!this.bindings.length) return false;
    // 独立包路径下作者场景矩阵不再每帧全量更新:只刷新变形模型自己的子树(含祖先)。
    for (const root of this.roots) root.updateWorldMatrix(true, true);
    let changed = false;
    for (const binding of this.bindings) {
      const previous = binding.current;
      const revision = Math.max(previous.revision, previous.palette?.revision ?? 0, previous.morphWeights?.revision ?? 0) + 1;
      const palette = binding.skinned ? captureAuthorSkinPalette(binding.mesh, revision, previous.palette) : undefined;
      const morph = binding.morphTargets ? readInfluences(binding.mesh as THREE.Mesh, previous.morphWeights?.values) : undefined;
      const paletteSame = !palette || palette === previous.palette || sameArray(palette.matrices, previous.palette?.matrices)
        && sameArray(palette.normalMatrices, previous.palette?.normalMatrices);
      const morphSame = !morph || morph === previous.morphWeights?.values;
      if (paletteSame && morphSame) continue;
      const next: Pose = { id: previous.id, source: previous.source, revision,
        ...(morph ? { morphWeights: { revision, values: morph } } : {}),
        ...(palette ? { palette: paletteSame ? previous.palette! : palette } : {}) };
      this.allPoses[binding.poseIndex] = next;
      binding.current = next; changed = true;
    }
    if (changed) target.updateDeformationPoses(this.allPoses);
    return changed;
  }
}

/** 权重未变返回 previous(同一引用);变化时返回新的独立数组。 */
function readInfluences(mesh: THREE.Mesh, previous: Float32Array<ArrayBuffer> | undefined): Float32Array<ArrayBuffer> {
  const influences = mesh.morphTargetInfluences!;
  if (previous && previous.length === influences.length) {
    let same = true;
    for (let index = 0; index < influences.length; index++) if (previous[index] !== Math.fround(influences[index]!)) { same = false; break; }
    if (same) return previous;
  }
  return Float32Array.from(influences);
}

function sameArray(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
