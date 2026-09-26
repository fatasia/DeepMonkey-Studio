import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { BinaryReader, JtFormatError, readJt } from "./index.js";
import { synthesizeUvColorJt } from "./fixtureSynthesis.test-helper.js";

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
});
