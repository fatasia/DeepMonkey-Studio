import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch } from "./packetBufferTypes.js";
import type { PreparedBatch } from "../renderPacket.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";
import type { StagedTextureSet, TextureResources } from "./textureResources.js";
import { buildTextureArrayPlan, TextureArrayResources } from "./textureArrayResources.js";
import type { TextureArrayMaterialTable } from "./textureArrayMaterialTable.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import type { PacketTextureLookup } from "./packetTextureLookup.js";
import type { TextureBinding } from "./textureResources.js";

export interface PacketTextureArrayStage {
  readonly resources?: TextureArrayResources;
  readonly table?: TextureArrayMaterialTable;
  readonly batches: readonly PreparedBatch[];
  readonly rows: ReadonlyMap<string, TextureArrayMaterialTable["rows"][number]>;
  readonly signatures: ReadonlyMap<string, string>;
  settled: boolean;
}

/** Owns packet-level array textures and the instance-indexed shared material table. */
export class PacketTextureArrayConsumer {
  private resources: TextureArrayResources | undefined;
  private table: TextureArrayMaterialTable | undefined;
  private rows = new Map<string, TextureArrayMaterialTable["rows"][number]>();
  private signatures = new Map<string, string>();

  constructor(private readonly session: DeviceSession, private readonly layout: GPUBindGroupLayout) {}

  plannedTextureIds(textures: readonly PreparedTexture[]): ReadonlySet<string> {
    const entries = textures.filter(texture => !texture.requiredFeature).map(texture => ({
      textureId: texture.id, format: texture.format, width: texture.levels[0]!.width,
      height: texture.levels[0]!.height,
      compatibilityKey: `${texture.samplerKey}|mips:${texture.levels.length}`,
    }));
    if (!entries.length) return new Set();
    return new Set(buildTextureArrayPlan(entries, this.session).assignments.keys());
  }

  stagedBinding(stage: PacketTextureArrayStage, textures: TextureResources,
    staged: StagedTextureSet, id: string): TextureBinding {
    return stage.resources?.textureBinding(id) ?? textures.stagedBinding(staged, id);
  }

  lookup(textures: TextureResources): PacketTextureLookup {
    return { semanticMap: () => textures.semanticMap(),
      get: id => this.resources?.textureBinding(id) ?? textures.get(id) };
  }

  stage(textures: TextureResources, stagedTextures: StagedTextureSet,
    batches: readonly PreparedBatch[]): PacketTextureArrayStage {
    const entries = textures.stagedArrayEntries(stagedTextures);
    if (!entries.length) return { batches, rows: new Map(), signatures: new Map(), settled: false };
    let resources: TextureArrayResources | undefined, table: TextureArrayMaterialTable | undefined;
    try {
      resources = new TextureArrayResources(this.session, buildTextureArrayPlan(entries, this.session),
        id => textures.stagedArrayLayer(stagedTextures, id), this.layout);
      const compatible = batches.filter(batch => batch.textures && resources!.supportsMaterial(batch.textures));
      table = resources.materialTable(compatible.map(batch => batch.textures!));
      const rows = new Map<string, TextureArrayMaterialTable["rows"][number]>();
      const signatures = new Map<string, string>();
      compatible.forEach((batch, index) => {
        rows.set(batch.key, table!.rows[index]!); signatures.set(batch.key, materialSignature(batch));
      });
      const decorated = batches.map(batch => {
        const row = rows.get(batch.key); return row ? this.decorateSource(batch, row) : batch;
      });
      return { resources, ...(table ? { table } : {}), batches: decorated, rows, signatures, settled: false };
    } catch (error) {
      runResourceCleanup("Texture-array packet staging rollback failed.", [
        () => table?.dispose(), () => resources?.dispose(),
      ]);
      throw error;
    }
  }

  publish(stage: PacketTextureArrayStage): void {
    if (stage.settled) throw new Error("Texture-array packet stage is already settled.");
    stage.settled = true;
    const oldTable = this.table, oldResources = this.resources;
    this.table = stage.table; this.resources = stage.resources;
    this.rows = new Map(stage.rows); this.signatures = new Map(stage.signatures);
    runResourceCleanup("Superseded texture-array packet retirement failed.", [
      () => oldTable?.dispose(), () => oldResources?.dispose(),
    ]);
  }

  rollback(stage: PacketTextureArrayStage): void {
    if (stage.settled) return;
    stage.settled = true;
    runResourceCleanup("Texture-array packet rollback failed.", [
      () => stage.table?.dispose(), () => stage.resources?.dispose(),
    ]);
  }

  remap(batches: ReadonlyMap<string, CachedPacketBatch>): Map<string, CachedPacketBatch> {
    if (!this.resources) return new Map(batches);
    const compatible = [...batches.values()].filter(batch => batch.source.textures
      && this.resources!.supportsMaterial(batch.source.textures));
    const next = compatible.length
      ? this.resources.materialTable(compatible.map(batch => batch.source.textures!))
      : undefined;
    const decorated = new Map(batches);
    const rows = new Map<string, TextureArrayMaterialTable["rows"][number]>();
    const signatures = new Map<string, string>();
    compatible.forEach((batch, index) => {
      const arrayMaterial = next!.rows[index]!;
      const source = this.decorateSource(batch.source, arrayMaterial, true);
      this.session.device.queue.writeBuffer(batch.buffer, 0, source.data);
      decorated.set(source.key, { ...batch, source, arrayMaterial });
      rows.set(source.key, arrayMaterial); signatures.set(source.key, materialSignature(source));
    });
    const old = this.table; this.table = next; this.rows = rows; this.signatures = signatures; old?.dispose();
    return decorated;
  }

  /** Reuses the active table when an instance-only update keeps every batch/material row compatible. */
  decorateCurrent(batches: readonly PreparedBatch[]): readonly PreparedBatch[] | undefined {
    if (!this.resources) return this.rows.size ? undefined : batches;
    const decorated: PreparedBatch[] = [];
    const seen = new Set<string>();
    for (const batch of batches) {
      const compatible = batch.textures !== undefined && this.resources.supportsMaterial(batch.textures);
      const row = this.rows.get(batch.key);
      if (compatible !== (row !== undefined)) return undefined;
      if (!row) { decorated.push(batch); continue; }
      if (this.signatures.get(batch.key) !== materialSignature(batch)) return undefined;
      seen.add(batch.key);
      decorated.push(this.decorateSource(batch, row));
    }
    return seen.size === this.rows.size ? decorated : undefined;
  }

  clear(): void {
    const table = this.table, resources = this.resources;
    this.table = undefined; this.resources = undefined;
    this.rows.clear(); this.signatures.clear();
    runResourceCleanup("Texture-array packet disposal failed.", [
      () => table?.dispose(), () => resources?.dispose(),
    ]);
  }

  private decorateSource(batch: PreparedBatch,
    row: TextureArrayMaterialTable["rows"][number], allowEncoded = false): PreparedBatch {
    if (row.materialRow > 16_383) throw new Error("Texture-array material row exceeds the instance flag encoding.");
    const data = new Float32Array(batch.data);
    for (let offset = 31; offset < data.length; offset += 36) {
      const flags = data[offset]!;
      if (!Number.isSafeInteger(flags) || flags < 0 || flags > (allowEncoded ? 16_777_215 : 1023)) {
        throw new Error("Texture-array material flags exceed the reserved low ten bits.");
      }
      data[offset] = flags % 1024 + row.materialRow * 1024;
    }
    return { ...batch, data };
  }
}

function materialSignature(batch: PreparedBatch): string {
  return JSON.stringify(batch.textures);
}
