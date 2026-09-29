import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FRAME_ABI_CORE,
  FRAME_ABI_RUST_BYTES,
  FRAME_ABI_RUST_FIELDS,
  FRAME_ABI_RUST_FLOATS,
  FRAME_ABI_RUST_ROWS,
  FRAME_ABI_SCHEMA_SHA256,
  FRAME_ABI_TS_BYTES,
  FRAME_ABI_TS_FIELDS,
  FRAME_ABI_TS_FLOATS,
} from "./frameLayout.js";
import { FRAME_STRUCTS_WGSL } from "./frameStructsWgsl.js";

const schemaPath = fileURLToPath(new URL("../../../frame-abi/frame-abi.schema.json", import.meta.url));
const schemaBytes = readFileSync(schemaPath);
const schema = JSON.parse(schemaBytes) as typeof import("../../../frame-abi/frame-abi.schema.json");

describe("frame ABI 单源产物指纹门（J2-B7-codegen）", () => {
  it("产物头戳 == 当前 schema sha256（改 schema 未再生即红）", () => {
    const digest = createHash("sha256").update(schemaBytes).digest("hex");
    expect(FRAME_ABI_SCHEMA_SHA256).toBe(digest);
    expect(FRAME_STRUCTS_WGSL).toContain(`schema-sha256: ${digest}`);
  });

  it("TS 宿主 parity：与手写真值（webgpu/pipelines.ts:14-18）逐项一致", () => {
    expect(FRAME_ABI_TS_FLOATS).toBe(96);
    expect(FRAME_ABI_TS_BYTES).toBe(384);
    const offsets = Object.fromEntries(FRAME_ABI_TS_FIELDS.map((field) => [field.name, field.offset]));
    // 核心段（双端同语义）
    expect(offsets.viewProjection).toBe(0);
    expect(offsets.lightViewProjection).toBe(48);
    expect(offsets.eye).toBe(64);
    expect(offsets.lightDirection).toBe(76);
    expect(offsets.sunColor).toBe(84);
    // TS 扩展带
    expect(offsets.previousViewProjection).toBe(16);
    expect(offsets.worldToView).toBe(32);
    expect(offsets.background).toBe(68);
    expect(offsets.floor).toBe(72);
    expect(offsets.tuning).toBe(80);
    expect(offsets.output).toBe(88);
  });

  it("Rust 宿主 parity：与手写真值（native mesh_abi.rs v8）逐项一致", () => {
    expect(FRAME_ABI_RUST_FLOATS).toBe(596);
    expect(FRAME_ABI_RUST_BYTES).toBe(2384);
    expect(FRAME_ABI_RUST_ROWS).toBe(149);
    const rows = Object.fromEntries(FRAME_ABI_RUST_FIELDS.map((field) => [field.name, field.row]));
    expect(rows.viewProjection).toBe(0);
    expect(rows.lightViewProjection).toBe(4);
    expect(rows.eye).toBe(8);
    expect(rows.lightDirection).toBe(11);
    expect(rows.sunColor).toBe(13);
    expect(rows.localLights).toBe(15);
    expect(rows.localShadowViews).toBe(79);
    expect(rows.fogProjection).toBe(143);
    expect(rows.localShadowSoftness).toBe(144);
    expect(rows.fogProfile).toBe(148);
  });

  it("产物字段与 schema 单源逐字段一致（core 5 + tsBand 6 + rustBand 8）", () => {
    expect(FRAME_ABI_CORE).toEqual(
      schema.coreFields.map(({ name, type, ts, rust, note }) => ({
        name, type, tsOffset: ts.offset, rustRow: rust.row, note,
      })),
    );
    expect(FRAME_ABI_TS_FIELDS).toEqual(
      [
        ...schema.coreFields.map((field) => ({
          name: field.name, type: field.type, offset: field.ts.offset, core: true, note: field.note,
        })),
        ...schema.tsBand.fields.map((field) => ({ ...field, core: false })),
      ].sort((a, b) => a.offset - b.offset),
    );
    expect(FRAME_ABI_RUST_FIELDS.filter((field) => field.core)).toHaveLength(schema.coreFields.length);
  });

  it("WGSL struct 文本含 TS 全部字段名且顺序按偏移", () => {
    const names = FRAME_ABI_TS_FIELDS.map((field) => field.name);
    let cursor = -1;
    for (const name of names) {
      const at = FRAME_STRUCTS_WGSL.indexOf(name);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(FRAME_STRUCTS_WGSL).toContain("struct Frame");
  });
});
