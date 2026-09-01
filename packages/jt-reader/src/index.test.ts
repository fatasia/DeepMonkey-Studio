import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { BinaryReader, JtFormatError, readJt } from "./index.js";

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
});
