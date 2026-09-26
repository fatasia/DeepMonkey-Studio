import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { BinaryReader, JtFormatError, readJt } from "./index.js";
import { synthesizeDualTextureSetJt, synthesizeMinimalPmiJt, synthesizeUvColorJt } from "./fixtureSynthesis.test-helper.js";

const exampleBlockFixture = new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt",
  import.meta.url,
);
const coffeeMakerFixture = new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-coffee-maker-jt9.5.jt",
  import.meta.url,
);

describe("JT reader", () => {
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
});
