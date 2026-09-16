import type { DeformationPose, DeformationSnapshot, DeformationSource } from "../deformation/types.js";
import { snapshotDeformation } from "../deformation/validation.js";
import { DeformationPoseValidator } from "../deformation/poseValidation.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuSkinner } from "./gpuSkinning.js";
import { GpuMorphDeformer } from "./gpuMorphDeformation.js";
import { GpuMorphSkinner } from "./gpuMorphSkinning.js";
import { GpuDeformationHistory } from "./gpuDeformationHistory.js";
import type { GpuDeformationHistoryResult, GpuDeformationHistorySource, GpuDeformationHistoryStage } from "./gpuDeformationHistoryTypes.js";
import { assertSnapshotRevisions, canonicalPose } from "./packetDeformationRevision.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { DeformationStaticSources, type DeformationStaticSourceStage } from "./deformationStaticSources.js";

type Deformer = GpuSkinner | GpuMorphDeformer | GpuMorphSkinner;
interface Entry {
  source: DeformationSource; uploaded: DeformationPose; gpu: Deformer; history: GpuDeformationHistory;
  submittedSource?: GpuDeformationHistorySource;
}
interface Frame { entry: Entry; stage: GpuDeformationHistoryStage; source: GpuDeformationHistorySource }
export interface PacketDeformationDrawStreams extends GpuDeformationHistoryResult { readonly stale: boolean }

/** Immutable static inputs are leased by source; dynamic outputs/history remain per pose.
 * The caller must discard an encoder after encode failure, and commit only after queue.submit succeeds.
 */
export class PacketDeformationResources {
  private entries = new Map<string, Entry>();
  private snapshot: DeformationSnapshot | undefined;
  private validator: DeformationPoseValidator | undefined;
  private ready = false;
  private disposed = false;
  private pending: Map<string, Frame> | undefined;
  private committed = new Map<string, GpuDeformationHistoryResult>();
  private retired: Entry[] = [];
  private staticStage: DeformationStaticSourceStage | undefined;
  private retiredStatic: DeformationStaticSourceStage[] = [];
  private readonly staticSources: DeformationStaticSources;

  constructor(private readonly session: DeviceSession, staticSources?: DeformationStaticSources) {
    this.staticSources = staticSources ?? new DeformationStaticSources(session);
  }
  get hasIncompleteUploads(): boolean { return this.snapshot !== undefined && !this.ready; }

  prepare(input: DeformationSnapshot, geometryRevisions: ReadonlyMap<string, number> = new Map()): void {
    this.assertIdle();
    const snapshot = snapshotDeformation(input);
    assertSnapshotRevisions(snapshot, this.snapshot);
    const validator = new DeformationPoseValidator(snapshot);
    const candidate = new Map<string, Entry>();
    const staticStage = this.staticSources.stage();
    try {
      for (const pose of snapshot.poses) {
        const source = snapshot.sources.find(item => item.id === pose.source)!;
        const staticUpload = staticStage.source(source, geometryRevisions.get(source.geometry) ?? source.revision);
        const gpu = source.kind === "skin" ? new GpuSkinner(this.session, staticUpload)
          : source.kind === "morph" ? new GpuMorphDeformer(this.session, staticUpload) : new GpuMorphSkinner(this.session, staticUpload);
        const entry = { source, uploaded: pose, gpu, history: new GpuDeformationHistory(this.session) };
        candidate.set(pose.id, entry);
        if (gpu instanceof GpuSkinner) gpu.setSource(source.skinning!, pose.palette!);
        else if (gpu instanceof GpuMorphDeformer) gpu.setSource(source.morph!, pose.morphWeights!);
        else gpu.setSource({ morph: source.morph!, skinning: source.skinning! }, { morphWeights: pose.morphWeights!, palette: pose.palette! });
      }
    } catch (error) {
      failWithResourceCleanup(error, "Packet deformation preparation failed.", [...cleanup([...candidate.values()]), () => staticStage.dispose()]);
    }
    this.retired.push(...this.entries.values());
    if (this.staticStage) this.retiredStatic.push(this.staticStage);
    this.staticStage = staticStage;
    this.entries = candidate; this.snapshot = snapshot; this.validator = validator; this.ready = true;
  }

  /** Only PacketBuffers' successful asynchronous GPU validation commit may call this. */
  publishValidatedSources(): void { this.assertIdle(); this.staticStage?.publishValidated(); }

  /** Full pose batch. Successful uploads are retained across retries; never roll back GPU revisions. */
  updatePoses(poses: readonly DeformationPose[]): void {
    this.assertIdle();
    if (!this.snapshot) throw new Error("Packet deformation is not prepared.");
    this.validator!.validate(poses);
    const next = { sources: this.snapshot.sources, poses: structuredClone(poses) };
    assertSnapshotRevisions(next, this.snapshot);
    if (poses.length !== this.entries.size || poses.some(pose => !this.entries.has(pose.id))) {
      throw new Error("Pose membership changes require prepare.");
    }
    // Canonicalize and validate ALL entries before the first GPU write.
    const updates = next.poses.map(pose => {
      const entry = this.entries.get(pose.id)!;
      if (pose.palette && pose.palette.matrices.length !== entry.uploaded.palette!.matrices.length) {
        throw new Error("Joint count changes require prepare.");
      }
      return { entry, pose: canonicalPose(pose, entry.uploaded) };
    });
    this.ready = false;
    // Retain the attempted revisions even if a later upload fails.
    this.snapshot = next;
    for (const { entry, pose } of updates) {
      if (entry.gpu instanceof GpuSkinner) entry.gpu.updatePalette(pose.palette!);
      else if (entry.gpu instanceof GpuMorphDeformer) entry.gpu.updateWeights(pose.morphWeights!);
      else entry.gpu.updateDynamics({ morphWeights: pose.morphWeights!, palette: pose.palette! });
      entry.uploaded = pose;
    }
    this.ready = true;
  }

  encode(encoder: GPUCommandEncoder): void {
    this.assertIdle();
    if (!this.ready) throw new Error("Packet deformation uploads are incomplete; retry updatePoses.");
    const pending = new Map<string, Frame>(); this.pending = pending;
    try {
      // All compute output commands precede all history copies.
      for (const [id, entry] of this.entries) {
        let source = entry.submittedSource;
        if (!source || source.sourceRevision !== entry.source.revision || source.poseRevision !== entry.uploaded.revision) {
          const output = entry.gpu.encode(encoder);
          source = { ...output, sourceRevision: entry.source.revision,
            poseRevision: entry.uploaded.revision, hasTangents: "hasTangents" in output ? output.hasTangents : false };
        }
        // History still stages unchanged poses to settle previous=current without copying.
        const stage = entry.history.begin(source);
        pending.set(id, { entry, stage, source });
      }
      for (const { entry, stage } of pending.values()) entry.history.encode(encoder, stage);
    } catch (error) {
      failWithResourceCleanup(error, "Packet deformation encode failed; discard encoder.", [() => this.cancelFrame()]);
    }
  }

  /** During encoding returns candidate streams; otherwise returns last successfully submitted streams. */
  drawStreams(poseId: string): PacketDeformationDrawStreams | undefined {
    this.assertReady();
    const staged = this.pending?.get(poseId)?.stage.result;
    const result = staged ?? this.committed.get(poseId);
    if (!result) return undefined;
    const entry = this.entries.get(poseId);
    return Object.freeze({ ...result, stale: !staged && (!this.ready || !entry
      || entry.uploaded.revision !== result.poseRevision || entry.source.revision !== result.sourceRevision
      || this.retired.length > 0) });
  }

  /** Call only after the containing command buffer was successfully submitted. */
  commitFrame(): void {
    this.assertReady();
    const pending = this.pending;
    if (!pending) throw new Error("No encoded deformation frame to commit.");
    this.pending = undefined;
    this.committed = new Map([...pending].map(([id, frame]) => [id, frame.stage.result]));
    const retired = this.retired; this.retired = [];
    const retiredStatic = this.retiredStatic; this.retiredStatic = [];
    runResourceCleanup("Packet deformation commit cleanup failed.", [
      ...[...pending.values()].map(({ entry, stage, source }) => () => {
        entry.history.commit(stage);
        // Only submitted output can bypass the producer; cancelled encoders never populate this cache.
        entry.submittedSource = source;
      }), ...cleanup(retired), ...retiredStatic.map(stage => () => stage.dispose()),
    ]);
  }

  cancelFrame(): void {
    const pending = this.pending; this.pending = undefined;
    if (pending) runResourceCleanup("Packet deformation cancellation failed.", [...pending.values()]
      .map(({ entry, stage }) => () => { entry.history.cancel(stage); }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values(), ...this.retired];
    const staticStages = [...this.retiredStatic, ...(this.staticStage ? [this.staticStage] : [])];
    this.retiredStatic = []; this.staticStage = undefined;
    this.entries.clear(); this.retired = []; this.committed.clear(); this.snapshot = undefined; this.validator = undefined; this.ready = false;
    runResourceCleanup("Packet deformation disposal failed.", [() => this.cancelFrame(), ...cleanup(entries), ...staticStages.map(stage => () => stage.dispose())]);
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Packet deformation resources are disposed.");
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for packet deformation.");
  }
  private assertIdle(): void {
    this.assertReady();
    if (this.pending) throw new Error("Commit or cancel the pending deformation frame first.");
  }
}

function cleanup(entries: readonly Entry[]): Array<() => void> {
  return entries.flatMap(entry => [() => entry.gpu.dispose(), () => entry.history.dispose()]);
}
