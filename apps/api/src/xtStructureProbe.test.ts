import { describe, expect, it } from "vitest";
import { XT_MAX_SAMPLE_BYTES, probeXtStructure } from "./xtStructureProbe.js";

describe("Parasolid XT structure probe", () => {
  it("识别 X_T 固定头、文本标志、modeller 和 schema，但不解析几何", () => {
    const result = probeXtStructure({ fileSize: 4096, expectedFormat: "x_t", sampleBytes: textFixture() });

    expect(result).toMatchObject({
      status: "header-recognized",
      recognizedFormat: "parasolid-x_t",
      encoding: "text",
      probeScope: "structure-only",
      geometryParsed: false,
      version: { raw: "SCH_3100154_31001", modellerVersion: "3100154", schemaNumber: "31001" },
      header: { application: "Example CAD", format: "text", userFieldSize: 0 },
      issues: [],
    });
    expect(result.evidence.limitations.join(" ")).toContain("B-Rep");
  });

  it("识别真实 SolidWorks 样本使用的紧凑 T51 与嵌入基准 schema", () => {
    const result = probeXtStructure({ fileSize: 6207, expectedFormat: "x_t", sampleBytes: compactTextFixture() });

    expect(result).toMatchObject({
      status: "header-recognized",
      recognizedFormat: "parasolid-x_t",
      encoding: "text",
      geometryParsed: false,
      version: { raw: "SCH_2401231_20000_1300", modellerVersion: "2401231", schemaNumber: "1300" },
      header: { application: "SolidWorks 2013-2012270", format: "text", userFieldSize: 0 },
      issues: [],
    });
  });

  it("按公开 neutral binary 布局限量读取 X_B 的版本与 schema", () => {
    const result = probeXtStructure({ fileSize: 4096, expectedFormat: "x_b", sampleBytes: neutralBinaryFixture() });

    expect(result).toMatchObject({
      status: "header-recognized",
      recognizedFormat: "parasolid-x_b",
      encoding: "neutral-binary",
      version: { raw: "SCH_3100154_31001", schemaNumber: "31001" },
      geometryParsed: false,
      issues: [],
    });
  });

  it("不猜测 bare binary 机器布局，并标记扩展名与内容不一致", () => {
    const bare = probeXtStructure({ fileSize: 4096, expectedFormat: "x_b", sampleBytes: withPayload(Uint8Array.of(0x42, 0, 0, 0)) });
    expect(bare).toMatchObject({ recognizedFormat: "parasolid-x_b", encoding: "bare-binary", issues: [{ code: "bare-binary-machine-layout-unknown" }] });

    const mismatch = probeXtStructure({ fileSize: 4096, expectedFormat: "x_b", sampleBytes: textFixture() });
    expect(mismatch.status).toBe("header-recognized");
    expect(mismatch.issues.at(-1)?.code).toBe("extension-encoding-mismatch");
  });

  it("限制样本和攻击者控制的二进制标识长度", () => {
    expect(probeXtStructure({ fileSize: XT_MAX_SAMPLE_BYTES + 1, sampleBytes: new Uint8Array(XT_MAX_SAMPLE_BYTES + 1) }).issues[0]?.code).toBe("sample-too-large");

    const payload = new Uint8Array(6);
    payload.set([0x50, 0x53, 0, 0]);
    new DataView(payload.buffer).setUint16(4, 513, false);
    const result = probeXtStructure({ fileSize: 4096, expectedFormat: "x_b", sampleBytes: withPayload(payload) });
    expect(result.issues[0]?.code).toBe("binary-identifier-too-large");
  });
});

function textFixture(): Uint8Array {
  const modeller = ": TRANSMIT FILE created by modeller version 3100154";
  const schema = "SCH_3100154_31001";
  return encode(`${header("text")}T${modeller.length} ${modeller}${schema.length} ${schema}0\n1 0`);
}

function compactTextFixture(): Uint8Array {
  const compactHeader = header("text")
    .replace("APPL=Example CAD", "APPL=SolidWorks 2013-2012270")
    .replace("SCH=SCH_3100154_31001", "SCH=SCH_2401231_20000_1300");
  // 只保留真实文件的 identification 形式，不复制任何几何节点。
  return encode(`${compactHeader}T51 : TRANSMIT FILE created by modeller version 240123123 SCH_2401231_20000_1300\n1 0`);
}

function neutralBinaryFixture(): Uint8Array {
  const modeller = ": TRANSMIT FILE created by modeller version 3100154";
  const schema = "SCH_3100154_31001";
  const payload = new Uint8Array(4 + 2 + modeller.length + 4 + schema.length + 4);
  payload.set([0x50, 0x53, 0, 0]);
  const view = new DataView(payload.buffer);
  view.setUint16(4, modeller.length, false);
  payload.set(encode(modeller), 6);
  const schemaOffset = 6 + modeller.length;
  view.setUint32(schemaOffset, schema.length, false);
  payload.set(encode(schema), schemaOffset + 4);
  view.setUint32(schemaOffset + 4 + schema.length, 0, false);
  return withPayload(payload);
}

function withPayload(payload: Uint8Array): Uint8Array {
  const prefix = encode(header("binary"));
  const result = new Uint8Array(prefix.length + payload.length);
  result.set(prefix);
  result.set(payload, prefix.length);
  return result;
}

function header(format: "text" | "binary"): string {
  return [
    "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz*****************",
    "***********PARASOLID!\"#$%&'()*+,-./:;<=>?@[\\\\]^_`{|}~0123456789*********",
    "*******************PART1;",
    `MC_MODEL=; APPL=Example CAD; FORMAT=${format};`,
    "**PART2;",
    "SCH=SCH_3100154_31001; USFLD_SIZE=0;",
    "**PART3;",
    "**END_OF_HEADER********************************************************",
  ].join("\n") + "\n";
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
