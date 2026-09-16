import type { GpuDeformationHistoryResult } from "./gpuDeformationHistoryTypes.js";
import type { MaterialBinding } from "./materialBindings.js";
import type { Pipelines } from "./pipelines.js";

interface CachedBinding {
  readonly current: GPUBuffer;
  readonly previous: GPUBuffer;
  readonly vertexCount: number;
  readonly group: GPUBindGroup;
}

/** Borrows pose/material resources. At most three double-buffer combinations per pose/material are retained. */
export class DeformationDrawBindings {
  private readonly poses = new Map<string, Map<MaterialBinding | undefined, CachedBinding[]>>();
  private disposed = false;

  constructor(private readonly device: GPUDevice, private readonly pipelines: Pipelines) {
    if (!pipelines.deformationPlainLayout) throw new Error("Deformation pipeline layouts are unavailable.");
  }

  get(poseId: string, streams: GpuDeformationHistoryResult, material?: MaterialBinding): GPUBindGroup {
    if (this.disposed) throw new Error("Deformation draw bindings are disposed.");
    if (!poseId.trim()) throw new Error("Deformation pose id is required.");
    const bytes = streams.vertexCount * 48;
    if (streams.outputStride !== 48 || !Number.isSafeInteger(streams.vertexCount) || streams.vertexCount < 1
      || !Number.isSafeInteger(bytes) || bytes > this.device.limits.maxStorageBufferBindingSize) {
      throw new Error("Deformation draw stream layout is invalid.");
    }
    for (const buffer of [streams.current, streams.previous]) {
      if (!buffer || buffer.size < bytes || !(buffer.usage & GPUBufferUsage.STORAGE) || buffer.mapState !== "unmapped") {
        throw new Error("Deformation draw requires complete unmapped storage buffers.");
      }
    }
    if (material?.normal && !streams.hasTangents) throw new Error("Normal-mapped deformation requires deformed tangents.");
    const materials = this.poses.get(poseId), cached = materials?.get(material) ?? [];
    const found = cached.find(item => item.current === streams.current && item.previous === streams.previous
      && item.vertexCount === streams.vertexCount);
    if (found) return found.group;
    const group = this.device.createBindGroup({ label: "Deep deformation material and pose",
      layout: material ? this.pipelines.materialLayout.material : this.pipelines.deformationPlainLayout!,
      entries: [...(material ? textureEntries(material) : []),
        { binding: 11, resource: { buffer: streams.current, size: bytes } },
        { binding: 12, resource: { buffer: streams.previous, size: bytes } }],
    });
    const next = [...cached.slice(-2), { current: streams.current, previous: streams.previous, vertexCount: streams.vertexCount, group }];
    const target = materials ?? new Map<MaterialBinding | undefined, CachedBinding[]>();
    target.set(material, next); this.poses.set(poseId, target);
    return group;
  }

  /** Call after packet/material publication to drop retired borrowed identities. */
  retain(active: ReadonlyMap<string, ReadonlySet<MaterialBinding | undefined>>): void {
    if (this.disposed) throw new Error("Deformation draw bindings are disposed.");
    for (const [poseId, materials] of this.poses) {
      const retained = active.get(poseId);
      if (!retained) { this.poses.delete(poseId); continue; }
      for (const material of materials.keys()) if (!retained.has(material)) materials.delete(material);
      if (!materials.size) this.poses.delete(poseId);
    }
  }

  dispose(): void { this.disposed = true; this.poses.clear(); }
}

function textureEntries(material: MaterialBinding): GPUBindGroupEntry[] {
  const fallback = material.base ?? material.metallicRoughness ?? material.normal ?? material.occlusion ?? material.emissive;
  if (!fallback) throw new Error("Deformation material has no texture binding.");
  const base = material.base ?? fallback, mr = material.metallicRoughness ?? fallback;
  const ao = material.occlusion ?? fallback, normal = material.normal ?? fallback, emissive = material.emissive ?? fallback;
  return [
    { binding: 0, resource: base.view }, { binding: 1, resource: base.sampler },
    { binding: 2, resource: mr.view }, { binding: 3, resource: mr.sampler },
    { binding: 4, resource: { buffer: material.parameters } },
    { binding: 5, resource: ao.view }, { binding: 6, resource: ao.sampler },
    { binding: 7, resource: normal.view }, { binding: 8, resource: normal.sampler },
    { binding: 9, resource: emissive.view }, { binding: 10, resource: emissive.sampler },
  ];
}
