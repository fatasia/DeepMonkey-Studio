import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { BinaryReader, JtFormatError, readJt } from "./index.js";
import { buildSceneGraph } from "./sceneGraph.js";
import { parseJtContainer } from "./container.js";
import { readSegmentPayload } from "./container.js";
import { DEFAULT_JT_READ_LIMITS } from "./types.js";
import { synthesizeDualTextureSetJt, synthesizeMinimalPmiJt, synthesizeSingleNonzeroTextureSetJt, synthesizeUvColorJt } from "./fixtureSynthesis.test-helper.js";

const exampleBlockFixture = new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt",
  import.meta.url,
);
const coffeeMakerFixture = new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-coffee-maker-jt9.5.jt",
  import.meta.url,
);

const independentTextureFixture = new URL(
  "../../../data/external-assets/format-fixtures/jt/independent-texture/painted-instanced-10.3.jt", import.meta.url,
);

describe("JT reader", () => {
  it("reads author-produced inline image bytes, UV set 1 and two source-path material instances", async () => {
    const document = await readJt(await readFile(independentTextureFixture));
    expect(document.sceneGraph.nodes[0]?.textureImages?.[0]).toMatchObject({
      objectId: 101, textureChannel: 0, textureSetIndex: 1, width: 2, height: 2, channels: 4,
    });
    expect([...document.sceneGraph.nodes[0]!.textureImages![0]!.pixels]).toEqual([
      255, 35, 45, 255, 25, 240, 135, 255, 25, 95, 255, 255, 255, 210, 20, 255,
    ]);
    expect(document.meshes[0]?.textureSets?.map((set) => set.textureSetIndex)).toEqual([1]);
    expect(document.meshInstances.map((item) => item.pathObjectIds)).toEqual([[1, 2], [1, 3]]);
    expect(document.losses?.some((item) => item.code === "uv-binding-absent")).toBe(false);
  });

  it("fail-closes unsupported image profile and missing image bytes", async () => {
    const source = new Uint8Array(await readFile(independentTextureFixture));
    const marker = Uint8Array.from([255, 35, 45, 255, 25, 240, 135, 255]);
    const imageOffset = Buffer.from(source).indexOf(marker);
    expect(imageOffset).toBeGreaterThan(0);
    const invalidVersion = source.slice();
    invalidVersion.set(new TextEncoder().encode("Version 11.3"), 0);
    await expect(readJt(invalidVersion)).rejects.toMatchObject({ code: "shape-version-unsupported" });
    const invalidMinor = source.slice();
    invalidMinor.set(new TextEncoder().encode("Version 10.5"), 0);
    await expect(readJt(invalidMinor)).rejects.toMatchObject({ code: "shape-version-unsupported" });
    const invalidSize = source.slice();
    new DataView(invalidSize.buffer).setUint32(imageOffset - 8, 64, true);
    await expect(readJt(invalidSize)).rejects.toMatchObject({ code: "attribute-encoding-unsupported" });
    await expect(readJt(source.subarray(0, imageOffset + 4))).rejects.toMatchObject({ code: "read-bounds-exceeded" });
  });
  it("拒绝越界读取", () => {
    const reader = new BinaryReader(new Uint8Array(4));
    expect(() => reader.u32(1)).toThrow(JtFormatError);
  });

  it("读取真实 JT 10.3 样例的目录、层级和属性", async () => {
    const fixture = await readFile(
      new URL("../../../data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt", import.meta.url),
    );
    const document = await readJt(fixture);
    expect(document.header.majorVersion).toBe(10);
    expect(document.header.minorVersion).toBe(3);
    expect(document.segments).toHaveLength(9);
    expect(document.sceneGraph.nodes).toHaveLength(11);
    expect(document.sceneGraph.propertyAtomCount).toBe(67);
    expect(document.sceneGraph.rootObjectIds.length).toBeGreaterThan(0);
    expect(document.sceneGraph.nodes.some((node) => Object.keys(node.properties).length > 0)).toBe(true);
    expect(document.sceneGraph.nodes.some((node) => node.kind === "part")).toBe(true);
    expect(document.sceneGraph.nodes.some((node) => "material.diffuseR" in node.properties)).toBe(true);
    expect(document.meshes).toHaveLength(3);
    expect(document.meshes.every((mesh) => mesh.vertexCount === 8)).toBe(true);
    expect(document.meshes.every((mesh) => mesh.triangleCount === 12)).toBe(true);
    expect(document.meshes.every((mesh) => mesh.sceneNodeObjectIds.length === 1)).toBe(true);
    expect(document.meshInstances).toHaveLength(3);
    expect(document.meshes[0]?.positions.every(Number.isFinite)).toBe(true);
    expect(Math.max(...document.meshes[0]!.positions)).toBe(100);
    expect(document.warnings).toEqual([]);
  });

  it("拒绝截断的 JT 文件", async () => {
    await expect(readJt(new Uint8Array(24))).rejects.toThrow(JtFormatError);
  });

  it("读取真实 JT 9.5 装配的 Deflate、CDP2、变换和多网格", async () => {
    const fixture = await readFile(
      new URL("../../../data/external-assets/format-fixtures/jt/voyager-coffee-maker-jt9.5.jt", import.meta.url),
    );
    const document = await readJt(fixture);
    expect(document.header.majorVersion).toBe(9);
    expect(document.header.minorVersion).toBe(5);
    expect(document.segments).toHaveLength(97);
    expect(document.sceneGraph.nodes).toHaveLength(256);
    expect(document.sceneGraph.propertyAtomCount).toBe(1_876);
    expect(document.sceneGraph.nodes.filter((node) => node.transform)).toHaveLength(71);
    expect(document.meshes).toHaveLength(44);
    expect(document.meshes.every((mesh) => mesh.sceneNodeObjectIds.length === 1)).toBe(true);
    expect(document.meshInstances).toHaveLength(64);
    expect(document.meshInstances.some((instance) => instance.worldTransform.some((value, index) => value !== [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][index]))).toBe(true);
    expect(document.meshes.reduce((sum, mesh) => sum + mesh.vertexCount, 0)).toBe(23_999);
    expect(document.meshes.reduce((sum, mesh) => sum + mesh.triangleCount, 0)).toBe(47_962);
    expect(document.meshes.every((mesh) => mesh.positions.every(Number.isFinite))).toBe(true);
    expect(document.warnings).toEqual([]);
  });

  it("真实样本不虚构 UV/顶点色:binding 字节证实两个样本都没有 UV/Color attribute", async () => {
    // 字节证据(test-output/jt-uv-debug/dump-bindings.mjs):
    //  - JT 9.5 全部 44 段 vertexBindings=0xa(坐标+法线),无颜色/UV/旗标/附属位
    //  - JT 10.3 全部 3 段 vertexBindings=0x4a(坐标+法线+旗标),同样无颜色/UV
    // 据此,解码器对真实样本必须输出"无 uvs/colors 且 unsupported 为空",禁止猜。
    const exampleBlock = await readJt(await readFile(exampleBlockFixture));
    expect(exampleBlock.meshes).toHaveLength(3);
    for (const mesh of exampleBlock.meshes) {
      expect(mesh.uvs).toBeUndefined();
      expect(mesh.colors).toBeUndefined();
      expect(mesh.unsupportedAttributeBindings).toEqual([]);
    }
    const coffeeMaker = await readJt(await readFile(coffeeMakerFixture));
    expect(coffeeMaker.meshes).toHaveLength(44);
    for (const mesh of coffeeMaker.meshes) {
      expect(mesh.uvs).toBeUndefined();
      expect(mesh.colors).toBeUndefined();
      expect(mesh.unsupportedAttributeBindings).toEqual([]);
    }
  });

  it("解码合成 fixture 的量化 UV 与 RGBA 顶点色", async () => {
    // 真实样本没有 UV/Color attribute,按任务纪律用合成 fixture 验证解码器:
    // 对 10.3 样本 LOD0 段做字节手术,插入量化(bits=8)UV 与颜色记录并翻转 vertexBindings。
    const source = await readFile(exampleBlockFixture);
    const document = await readJt(synthesizeUvColorJt(new Uint8Array(source)));
    expect(document.warnings).toEqual([]);
    const lod0 = document.meshes.find((mesh) => mesh.lod === 0);
    expect(lod0).toBeDefined();
    const uvs = lod0!.uvs;
    const colors = lod0!.colors;
    expect(uvs).toBeDefined();
    expect(colors).toBeDefined();
    expect(uvs!.length).toBe(lod0!.vertexCount * 2);
    expect(colors!.length).toBe(lod0!.vertexCount * 4);
    // UV 合成值域:u=i/7、v=1-i/7,全部截在 [0,1] 且两端可达
    for (let index = 0; index < uvs!.length; index += 2) {
      const u = uvs![index]!;
      const v = uvs![index + 1]!;
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.min(...Array.from(uvs!))).toBe(0);
    expect(Math.max(...Array.from(uvs!))).toBeCloseTo(1, 5);
    // 颜色合成值域:R 从 0 渐变到 1、A 恒 1;线性化后仍在 [0,1]
    const colorsFlat = Array.from(colors!);
    const red = colorsFlat.filter((_, index) => index % 4 === 0);
    expect(red[0]).toBe(0);
    expect(red.at(-1)).toBeCloseTo(1, 5);
    for (const value of colorsFlat) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(colorsFlat.filter((_, index) => index % 4 === 3)).toEqual(Array.from({ length: lod0!.vertexCount }, () => 1));
  });

  it("拒绝损坏的 UV 属性记录:量化码越界按既有错误风格显式失败", async () => {
    // 在合法合成文件基础上,把 UV 的 u 分量 Null CDP 首个量化码改成超出 2^bits-1 的巨大值;
    // 解码必须以 JtFormatError 显式拒绝并进入 warnings,而不是输出猜测值。
    const source = await readFile(exampleBlockFixture);
    const synthetic = synthesizeUvColorJt(new Uint8Array(source));
    const { parseJtContainer } = await import("./container.js");
    const { DEFAULT_JT_READ_LIMITS } = await import("./types.js");
    const parsed = parseJtContainer(synthetic, DEFAULT_JT_READ_LIMITS);
    const segment = parsed.segments.find((candidate) => candidate.type === 7)!;
    // UV 记录位于 LOD0 段 payload 内偏移 770(颜色记录 210B 之后);其 u 分量 Null CDP 数据起于 +24+9。
    const uCodeOffset = segment.offset + 24 + 770 + 24 + 9;
    const dataView = new DataView(synthetic.buffer, synthetic.byteOffset, synthetic.byteLength);
    expect(dataView.getInt32(uCodeOffset, true)).toBe(0); // u 首码 = round(0/7*255) = 0
    dataView.setInt32(uCodeOffset, 0x7fffffff, true);
    const document = await readJt(synthetic);
    expect(document.meshes.some((mesh) => mesh.lod === 0 && mesh.uvs)).toBe(false);
    expect(document.warnings.some((warning) => warning.includes("LOD 数据段") && warning.includes("量化码越界"))).toBe(true);
  });

  it("拒绝附属字段(aux)顶点属性并如实上报为不支持", async () => {
    // 附属字段(auxiliary fields,bit7)当前解码器不支持:遇到时必须在消费任何 aux 字节前
    // 显式报错进 warnings,且不得虚构几何。构造:对真实 10.3 样本 LOD0 段
    // (bindings=0x4a,旗标记录之后紧跟 inner 元素终点)仅置 aux 位,
    // 解码器在旗标消费后立即命中 aux 拒绝分支。
    const source = await readFile(exampleBlockFixture);
    const synthetic = new Uint8Array(source);
    const { parseJtContainer } = await import("./container.js");
    const { DEFAULT_JT_READ_LIMITS } = await import("./types.js");
    const parsed = parseJtContainer(synthetic, DEFAULT_JT_READ_LIMITS);
    const segment = parsed.segments.find((candidate) => candidate.type === 7)!;
    for (const bindingsOffset of [segment.offset + 24 + 27, segment.offset + 24 + 247]) {
      const view = new DataView(synthetic.buffer, synthetic.byteOffset, synthetic.byteLength);
      view.setBigUint64(bindingsOffset, view.getBigUint64(bindingsOffset, true) | 0x80n, true);
    }
    const document = await readJt(synthetic);
    expect(document.meshes.some((mesh) => mesh.lod === 0)).toBe(false);
    expect(document.warnings.some((warning) => warning.includes("附属字段"))).toBe(true);
  });

  it("解析真实 JT 10.3 样本的 PMI 数据段结构清单(段类型 dump 证据驱动)", async () => {
    // TOC dump 证据:10.3 样本含 type=3 PMI 段(id a5bbafb9-...,865B XZ,解压 6910B),
    // 唯一元素 GUID = ce357249(PMI Manager),9 关联 / 0 用户属性 / 10 字符串 / 8 视图×9 属性对;
    // 9.5 样本(coffee-maker)97 个段中无 type=3,reader 必须如实省略 pmi 节。
    const exampleBlock = await readJt(await readFile(exampleBlockFixture));
    expect(exampleBlock.pmi).toBeDefined();
    const pmi = exampleBlock.pmi!;
    expect(pmi.segmentCount).toBe(1);
    expect(pmi.structureOnly).toBe(true);
    expect(pmi.entityCount).toBe(9 + 8 + 72);
    expect(pmi.types).toEqual([
      { type: "association", count: 9 },
      { type: "modelView", count: 8 },
      { type: "view-property", count: 72 },
    ]);
    const summary = pmi.segments[0]!;
    expect(summary.segmentId).toBe("a5bbafb9-bd6b-11e9-8000-d86f480d14fb");
    expect(summary.managerCount).toBe(1);
    expect(summary.elementVersion).toBe(2);
    expect(summary.structureVersion).toBe(0);
    expect(summary.strings).toEqual([
      '"Top"', "MVStyle", "PMI", '"Front"', '"Right"', '"Back"', '"Bottom"', '"Left"', '"Isometric"', '"Trimetric"',
    ]);
    expect(summary.modelViewNames).toEqual([
      '"Top"', '"Front"', '"Right"', '"Back"', '"Bottom"', '"Left"', '"Isometric"', '"Trimetric"',
    ]);
    expect(pmi.notes.some((note) => note.includes("pmi:structure-only"))).toBe(true);
    expect(exampleBlock.warnings).toEqual([]);

    const coffeeMaker = await readJt(await readFile(coffeeMakerFixture));
    expect(coffeeMaker.pmi).toBeUndefined();
    expect(coffeeMaker.warnings.every((warning) => !warning.includes("PMI"))).toBe(true);
  });

  it("解析追加到真实文件的合成最小 PMI 段(端到端)并拒绝损坏的 PMI 计数", async () => {
    const source = await readFile(exampleBlockFixture);
    const synthetic = await readJt(synthesizeMinimalPmiJt(new Uint8Array(source)));
    // 合成文件同时保留原样本 PMI 段与追加的合成段(0 关联、0 用户属性、1 字符串、0 视图)。
    expect(synthetic.segments).toHaveLength(10);
    expect(synthetic.pmi).toBeDefined();
    expect(synthetic.pmi!.segmentCount).toBe(2);
    const syntheticSummary = synthetic.pmi!.segments.find(
      (candidate) => candidate.segmentId === "a5bbafb0-bd6b-11e9-8000-d86f480d14fb",
    );
    expect(syntheticSummary).toBeDefined();
    expect(syntheticSummary!.strings).toEqual(["PMI"]);
    expect(syntheticSummary!.modelViewNames).toEqual([]);
    expect(syntheticSummary!.entityGroups).toEqual([
      { type: "association", count: 0 },
      { type: "modelView", count: 0 },
      { type: "view-property", count: 0 },
    ]);
    expect(synthetic.warnings).toEqual([]);

    // 拒绝路径:把字符串数量改成负数,解析必须显式失败进 warnings 且不产出 pmi 节。
    const corrupted = synthesizeMinimalPmiJt(new Uint8Array(source));
    const { parseJtContainer } = await import("./container.js");
    const { DEFAULT_JT_READ_LIMITS } = await import("./types.js");
    const parsed = parseJtContainer(corrupted, DEFAULT_JT_READ_LIMITS);
    const pmiSegment = parsed.segments.find(
      (candidate) => candidate.type === 3 && candidate.id === "a5bbafb0-bd6b-11e9-8000-d86f480d14fb",
    )!;
    // 元素数据区起于段 payload + 25(元素长度 4 + GUID 16 + 基础类型 1 + 对象 ID 4),
    // 头部 7B(版本 1 + 附加版本 2 + 结构版本 2 + 保留 2)后依次为关联数 4、用户属性数 4。
    const stringCountOffset = pmiSegment.offset + 24 + 25 + 7 + 8;
    const dataView = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
    expect(dataView.getInt32(stringCountOffset, true)).toBe(1);
    dataView.setInt32(stringCountOffset, -3, true);
    const broken = await readJt(corrupted);
    // 损坏的合成段必须显式失败进 warnings 且不出现在清单中;原样本 PMI 段不受影响,仍正常解析。
    expect(broken.pmi!.segmentCount).toBe(1);
    expect(broken.pmi!.segments.some((candidate) => candidate.segmentId === "a5bbafb0-bd6b-11e9-8000-d86f480d14fb")).toBe(false);
    expect(broken.warnings.some((warning) => warning.includes("a5bbafb0") && warning.includes("字符串数量"))).toBe(true);
  });

  it("解码合成双纹理集 fixture:两套 UV 按集合分档,互不混流", async () => {
    // 真实样本无任何纹理集绑定(byte 证据 0xa/0x4a),双集路径按任务纪律用合成 fixture 验证:
    // 翻转 bit8..11(集 0)与 bit12..15(集 1),插入两条互为补偿的量化 UV 记录。
    const source = await readFile(exampleBlockFixture);
    const document = await readJt(synthesizeDualTextureSetJt(new Uint8Array(source)));
    expect(document.warnings).toEqual([]);
    const lod0 = document.meshes.find((mesh) => mesh.lod === 0);
    expect(lod0).toBeDefined();
    expect(lod0!.textureSets).toHaveLength(2);
    const [set0, set1] = lod0!.textureSets!;
    expect(set0!.textureSetIndex).toBe(0);
    expect(set1!.textureSetIndex).toBe(1);
    for (const set of [set0, set1]) {
      expect(set!.uvs.length).toBe(lod0!.vertexCount * 2);
      expect(Array.from(set!.uvs).every((value) => value >= 0 && value <= 1)).toBe(true);
    }
    // 集 0:u=i/7;集 1:u=1-i/7 —— 同一顶点在两套集合中的 u 值互补。
    expect(set0!.uvs[0]).toBe(0);
    expect(set1!.uvs[0]).toBeCloseTo(1, 5);
    for (let vertex = 0; vertex < lod0!.vertexCount; vertex += 1) {
      const u0 = set0!.uvs[vertex * 2]!;
      const u1 = set1!.uvs[vertex * 2]!;
      expect(u0 + u1).toBeCloseTo(1, 4);
    }
    // 单集别名语义:多集网格的 uvs 字段等价于集 0。
    expect(lod0!.uvs).toBe(set0!.uvs);
  });

  it("保留唯一非零纹理集的源编号,不把集合 1 当作集合 0", async () => {
    const source = await readFile(exampleBlockFixture);
    const document = await readJt(synthesizeSingleNonzeroTextureSetJt(new Uint8Array(source)));
    expect(document.warnings).toEqual([]);
    const lod0 = document.meshes.find((mesh) => mesh.lod === 0)!;
    expect(lod0.textureSets).toHaveLength(1);
    expect(lod0.textureSets![0]!.textureSetIndex).toBe(1);
    expect(lod0.uvs).toBe(lod0.textureSets![0]!.uvs);
  });

  it("拒绝损坏的第二纹理集记录:量化码越界显式失败,不输出部分解码的网格", async () => {
    const source = await readFile(exampleBlockFixture);
    const synthetic = synthesizeDualTextureSetJt(new Uint8Array(source));
    const { parseJtContainer } = await import("./container.js");
    const { DEFAULT_JT_READ_LIMITS } = await import("./types.js");
    const parsed = parseJtContainer(synthetic, DEFAULT_JT_READ_LIMITS);
    const segment = parsed.segments.find((candidate) => candidate.type === 7)!;
    // 每条 UV 记录 = 头 6B + 量化器 18B + 两个 Null CDP(各 41B)+ 尾哈希 4B = 110B;
    // 两条记录起于插入点 560(颜色记录缺席),集 1 记录 @670,其 u 分量 Null CDP
    // 数据起于记录起点 + 33(与既有"拒绝损坏的 UV"测试的 770+33 同一推导)。
    const set1UCodeOffset = segment.offset + 24 + 560 + 110 + 33;
    const dataView = new DataView(synthetic.buffer, synthetic.byteOffset, synthetic.byteLength);
    expect(dataView.getInt32(set1UCodeOffset, true)).toBe(255); // 集 1 的 u 首码 = round((1-0/7)*255)
    dataView.setInt32(set1UCodeOffset, 0x7fffffff, true);
    const document = await readJt(synthetic);
    expect(document.meshes.some((mesh) => mesh.lod === 0 && mesh.textureSets)).toBe(false);
    expect(document.warnings.some((warning) => warning.includes("LOD 数据段") && warning.includes("量化码越界"))).toBe(true);
  });

  it("错误码稳定:损坏量化码进结构化 loss 并携带机读 errorCode", async () => {
    // 与上一测试同一损坏字节:机器消费只依赖 loss.code/errorCode,不解析 detail 措辞。
    const source = await readFile(exampleBlockFixture);
    const synthetic = synthesizeUvColorJt(new Uint8Array(source));
    const { parseJtContainer } = await import("./container.js");
    const { DEFAULT_JT_READ_LIMITS } = await import("./types.js");
    const parsed = parseJtContainer(synthetic, DEFAULT_JT_READ_LIMITS);
    const segment = parsed.segments.find((candidate) => candidate.type === 7)!;
    const uCodeOffset = segment.offset + 24 + 770 + 24 + 9;
    const dataView = new DataView(synthetic.buffer, synthetic.byteOffset, synthetic.byteLength);
    dataView.setInt32(uCodeOffset, 0x7fffffff, true);
    const document = await readJt(synthetic);
    const loss = document.losses!.find((entry) => entry.code === "mesh-segment-decode-failed");
    expect(loss).toBeDefined();
    expect(loss!.kind).toBe("loss");
    expect(loss!.errorCode).toBe("quantization-code-out-of-range");
    expect(loss!.scope.startsWith("segment:")).toBe(true);
    expect(loss!.detail).toBe(document.warnings.find((warning) => warning.includes("量化码越界")));
  });

  it("错误码稳定:附属字段拒绝携带 attribute-encoding-unsupported", async () => {
    const source = await readFile(exampleBlockFixture);
    const synthetic = new Uint8Array(source);
    const { parseJtContainer } = await import("./container.js");
    const { DEFAULT_JT_READ_LIMITS } = await import("./types.js");
    const parsed = parseJtContainer(synthetic, DEFAULT_JT_READ_LIMITS);
    const segment = parsed.segments.find((candidate) => candidate.type === 7)!;
    // 与既有 aux 拒绝测试同构:外层与内层 TopoMesh 绑定掩码必须同时置位,
    // 否则先命中"内外绑定一致"守卫(binding-mismatch),到不了 aux 拒绝分支。
    for (const bindingsOffset of [segment.offset + 24 + 27, segment.offset + 24 + 247]) {
      const view = new DataView(synthetic.buffer, synthetic.byteOffset, synthetic.byteLength);
      view.setBigUint64(bindingsOffset, view.getBigUint64(bindingsOffset, true) | 0x80n, true);
    }
    const document = await readJt(synthetic);
    const loss = document.losses!.find((entry) => entry.code === "mesh-segment-decode-failed");
    expect(loss!.errorCode).toBe("attribute-encoding-unsupported");
  });

  it("错误码稳定:截断文件以 JtFormatError 拒绝并携带 read-bounds-exceeded", async () => {
    const error: JtFormatError = await readJt(new Uint8Array(24)).then(
      () => { throw new Error("应当拒绝"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(JtFormatError);
    expect(error.code).toBe("read-bounds-exceeded");
  });

  it("损失声明覆盖:10.3 真实样本边界与源事实按确定性顺序记录", async () => {
    const document = await readJt(await readFile(exampleBlockFixture));
    expect(document.losses!.map((entry) => [entry.code, entry.kind])).toEqual([
      ["tessellation-only", "known-limitation"],
      ["uv-binding-absent", "source-fact"],
      ["pmi-structure-only", "known-limitation"],
    ]);
    // 无解码失败:真实样本不得出现 loss 级记录。
    expect(document.losses!.every((entry) => entry.kind !== "loss")).toBe(true);
  });

  it("损失声明覆盖:9.5 样本无 PMI 段,声明 pmi-segment-absent 源事实", async () => {
    const document = await readJt(await readFile(coffeeMakerFixture));
    const codes = document.losses!.map((entry) => entry.code);
    expect(codes).toContain("tessellation-only");
    expect(codes).toContain("uv-binding-absent");
    expect(codes).toContain("pmi-segment-absent");
    expect(codes).not.toContain("pmi-structure-only");
    expect(document.losses!.every((entry) => entry.kind !== "loss")).toBe(true);
  });

  it("按 JT 8.x 布局解释 LSG 对象头与属性原子(无版本字段前缀)", () => {
    // 真实缺陷回归(PyOpenJt 8.0/8.1 样本,见 T22 报告 9.x 编码缺口切片):
    // 8.x 属性原子 = 状态标志 U32 后直接是值/引用,无 9.x 的版本字段;
    // 延迟加载引用 = GUID16 + 类型 I32(无对象 ID 与保留字段),共 24 字节。
    // 节点 = 状态标志 U32 + 属性计数向量 + 子引用。
    const i32le = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
    const mbString8x = (text: string): number[] => [
      0, 0, 0, 0, ...i32le(text.length),
      ...[...text].flatMap((char) => [char.charCodeAt(0) & 0xff, (char.charCodeAt(0) >>> 8) & 0xff]),
    ];
    const element = (objectId: number, objectTypeId: string, payload: number[]) => ({
      objectId,
      objectTypeId,
      baseType: 1,
      payload: Uint8Array.from(payload),
      streamOffset: 0,
    });
    const latePayload = [0, 0, 0, 0, 0x11, 0, 0, 0, 0x22, 0, 0x33, 0, 1, 2, 3, 4, 5, 6, 7, 8, ...i32le(4)];
    const sections = {
      sceneElements: [element(2, "10dd102a-2ac8-11d1-9b6b-0080c7bb5997", [0, 0, 0, 0, 0, 0, 0, 0, ...i32le(7)])],
      propertyAtoms: [
        element(10, "10dd106e-2ac8-11d1-9b6b-0080c7bb5997", mbString8x("JT_PROP_NAME")),
        element(11, "10dd106e-2ac8-11d1-9b6b-0080c7bb5997", mbString8x("CD")),
        element(12, "e0b05be5-fbbd-11d1-a3a7-00aa00d10954", latePayload),
      ],
      propertyTableOffset: 0,
    };
    // 属性表:i16 版本 + i32 条目数 + {对象 ID, (键,值) 对(键 0 终止)};延迟加载经值 ID 关联。
    const table = new Uint8Array([
      1, 0, ...i32le(1),
      ...i32le(2),
      ...i32le(10), ...i32le(11),
      ...i32le(12), ...i32le(12),
      ...i32le(0),
    ]);
    const graph = buildSceneGraph(table, sections, "little-endian", DEFAULT_JT_READ_LIMITS, 8);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.properties["JT_PROP_NAME"]).toBe("CD");
    expect(graph.nodes[0]!.lateLoadedSegments).toHaveLength(1);
    expect(graph.nodes[0]!.lateLoadedSegments![0]!.type).toBe(4);
    expect(graph.nodes[0]!.lateLoadedSegments![0]!.payloadObjectId).toBeUndefined();
    expect(graph.rootObjectIds).toEqual([2]);

    // 反例(fail-closed):同一批 8.x 原子若按 9.x 布局解释必然显式越界,不得静默接受。
    expect(() => buildSceneGraph(table, sections, "little-endian", DEFAULT_JT_READ_LIMITS, 9)).toThrow(JtFormatError);
  });

  it("压缩段声明长度少记时按物理字节容差解压;真缺失仍显式拒绝", async () => {
    // 真实缺陷回归(Warehouse.jt,TechSoft3D JT writer 8.1):压缩声明长度比段内可用多 1 字节,
    // 缺的字节物理存在于文件末尾且无任何段认领;zlib 流自带校验和,允许顺延补足并解压。
    const { deflateSync } = await import("node:zlib");
    const payload = Uint8Array.from(Array.from({ length: 64 }, (_, index) => (index * 37 + 11) & 0xff));
    const stream = deflateSync(payload);
    const segGuid = Uint8Array.from([0x11, 0, 0, 0, 0x22, 0, 0x33, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const declaredSegLen = 24 + 9 + stream.length; // 故意比物理字节少记 1
    const buildFile = (encodedLength: number): Uint8Array => {
      const tocOffset = 105 + declaredSegLen + 1;
      const file = new Uint8Array(tocOffset + 4 + 28);
      const view = new DataView(file.buffer);
      const versionText = "Version 8.0 JT";
      file.set([...versionText].map((char) => char.charCodeAt(0)), 0);
      view.setUint32(85, tocOffset, true);
      file.set(segGuid, 89);
      // 数据段(物理多 1 字节,声明长度少记 1)
      let cursor = 105;
      file.set(segGuid, cursor);
      view.setInt32(cursor + 16, 1, true);
      view.setInt32(cursor + 20, declaredSegLen, true);
      cursor += 24;
      view.setUint32(cursor, 2, true); // 压缩标记 zlib
      view.setUint32(cursor + 4, encodedLength, true); // 含算法字节
      file[cursor + 8] = 2; // 算法标识
      file.set(stream, cursor + 9);
      // TOC
      view.setUint32(tocOffset, 1, true);
      file.set(segGuid, tocOffset + 4);
      view.setUint32(tocOffset + 20, 105, true);
      view.setUint32(tocOffset + 24, declaredSegLen, true);
      view.setUint32(tocOffset + 28, 0x01000000, true);
      return file;
    };
    const container = parseJtContainer(buildFile(stream.length + 1), DEFAULT_JT_READ_LIMITS);
    const lsgBytes = await readSegmentPayload(container, container.segments[0]!, DEFAULT_JT_READ_LIMITS);
    expect([...lsgBytes]).toEqual([...payload]);

    // 反例:声明长度连物理文件都覆盖不了 → 段载荷无效,显式拒绝(fail-closed)。
    const badContainer = parseJtContainer(buildFile(stream.length + 100), DEFAULT_JT_READ_LIMITS);
    try {
      await readSegmentPayload(badContainer, badContainer.segments[0]!, DEFAULT_JT_READ_LIMITS);
      expect.unreachable("声明数据缺失时必须抛出 JtFormatError");
    } catch (error) {
      expect(error).toBeInstanceOf(JtFormatError);
      expect((error as JtFormatError).code).toBe("segment-payload-invalid");
    }
  });

  it("错误码词表机器可读:JT_ERROR_CODES/JT_LOSS_CODES 导出且互不重叠", async () => {
    const { JT_ERROR_CODES } = await import("./errors.js");
    const { JT_LOSS_CODES } = await import("./types.js");
    expect(JT_ERROR_CODES.length).toBeGreaterThanOrEqual(20);
    expect(JT_LOSS_CODES.length).toBe(10);
    for (const code of JT_ERROR_CODES) expect(typeof code).toBe("string");
    for (const code of JT_LOSS_CODES) expect(typeof code).toBe("string");
    // 两词表职责分离:错误码描述解析失败,损失码描述产物缺失,不得共用同一标识。
    for (const lossCode of JT_LOSS_CODES) expect(JT_ERROR_CODES).not.toContain(lossCode);
  });
});
