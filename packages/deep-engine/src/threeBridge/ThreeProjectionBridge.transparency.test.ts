import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bakeRenderPacket } from "../assetBakePlan.js";
import { prepareRenderPacket } from "../renderPacket.js";
import { materializeRuntimeRenderPacket, serializeBrowserRenderPacket } from "../runtimePackage/renderPacket.js";
import { shadowMode, transparencySupportMatrix } from "../webgpu/pipelines.js";
import { bridge, mesh, project } from "./testFixture.js";

/** 双面玻璃作者路径:透明 + 不写深度 + DoubleSide(不要求 forceSinglePass)。 */
function glass(override: (material: THREE.MeshStandardMaterial) => void = () => {}) {
  const target = mesh();
  target.material.transparent = true;
  target.material.opacity = 0.4;
  target.material.depthWrite = false;
  target.material.side = THREE.DoubleSide;
  override(target.material);
  return target;
}

function reject(target: THREE.Mesh, feature: string, code: "unsupported" | "invalid" = "unsupported"): void {
  const result = bridge().project(target, { cameraLayerMask: 1 });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`Expected rejection: ${feature}`);
  expect(result.issues[0]).toMatchObject({ code, feature });
}

describe("DE26/C03 transparency and two-sided contract", () => {
  it("accepts the common two-sided glass path and folds the two-pass declaration into order-independent OIT", () => {
    const target = glass(); // 未设置 forceSinglePass(缺省)
    const projected = project(bridge(), target);
    expect(projected.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0.4, doubleSided: true });
    const prepared = prepareRenderPacket(projected.packet);
    expect(prepared.batches[0]).toMatchObject({ alphaMode: "BLEND", doubleSided: true });
    expect(prepared.batches[0]).not.toHaveProperty("premultipliedAlpha");
  });

  it("keeps overlapping and crossing two-sided glass in one order-independent batch regardless of transforms", () => {
    const root = new THREE.Group(), a = glass(), b = glass();
    b.material = a.material; b.geometry = a.geometry; // 同材质同几何才合并为单批次(桥按身份去重)
    a.position.set(0, 0, 0); b.position.set(0.5, 0.5, 0.5); b.rotation.set(0.3, 1.1, 0);
    root.add(a, b);
    const prepared = prepareRenderPacket(project(bridge(), root).packet);
    expect(prepared.batches).toHaveLength(1);
    expect(prepared.batches[0]).toMatchObject({ alphaMode: "BLEND", doubleSided: true, count: 2 });
  });

  it("keeps mirrored two-sided glass back-face visible without flipping the batch", () => {
    const root = new THREE.Group(), front = glass(), mirrored = glass();
    mirrored.material = front.material; mirrored.geometry = front.geometry;
    mirrored.scale.x = -1; mirrored.position.x = 3;
    root.add(front, mirrored);
    const prepared = prepareRenderPacket(project(bridge(), root).packet);
    // doubleSided 折叠镜像 raster(cull none 已保留背面),镜像与非镜像共享批次。
    expect(prepared.batches).toHaveLength(1);
    expect(prepared.batches[0]).toMatchObject({ mirrored: false, doubleSided: true, count: 2 });
  });

  it("projects premultiplied glass as an explicit material field with its own batch identity", () => {
    const root = new THREE.Group(), straight = glass(), premultiplied = glass(material => { material.premultipliedAlpha = true; });
    premultiplied.position.x = 3;
    root.add(straight, premultiplied);
    const projected = project(bridge(), root);
    expect(projected.packet.materials[1]).toMatchObject({ alphaMode: "BLEND", premultipliedAlpha: true });
    const prepared = prepareRenderPacket(projected.packet);
    // 不同混合公式不得合并批次:premultiplied 批次显式标记,key 后缀隔离。
    expect(prepared.batches).toHaveLength(2);
    expect(prepared.batches.find(batch => batch.premultipliedAlpha)).toMatchObject({ alphaMode: "BLEND", count: 1 });
    expect(prepared.batches.find(batch => !batch.premultipliedAlpha)).toMatchObject({ alphaMode: "BLEND", count: 1 });
  });

  it("keeps transparency settings across material-only updates and JSON publication roundtrip", () => {
    const target = bridge(), pane = glass(material => { material.premultipliedAlpha = true; });
    const first = project(target, pane); first.acknowledge();
    pane.position.x += 2; // 仅变换更新,材质设置必须原样保留
    const second = project(target, pane);
    expect(second.update).toBe("instances");
    expect(second.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", premultipliedAlpha: true, doubleSided: true });
    // 发布链路往返:serialize(桥的 Float64 变换规整为 Float32)→ materialize,透明语义逐字段保真。
    const serializable = { ...second.packet,
      instances: second.packet.instances.map(instance => ({ ...instance, transform: new Float32Array(instance.transform) })) };
    const republished = materializeRuntimeRenderPacket(JSON.parse(serializeBrowserRenderPacket(serializable as never)), "$");
    expect(republished.materials[0]).toMatchObject({ alphaMode: "BLEND", premultipliedAlpha: true, doubleSided: true });
    expect(prepareRenderPacket(republished).batches[0]).toMatchObject({ premultipliedAlpha: true, doubleSided: true });
    expect(bakeRenderPacket(second.packet).materialVariantKeys[0]).toContain("premultiplied");
  });

  it("encodes the two-sided premultiplied flags into instance data for shader dispatch", () => {
    const projected = project(bridge(), glass(material => { material.premultipliedAlpha = true; }));
    const prepared = prepareRenderPacket(projected.packet);
    const flags = prepared.batches[0]!.data[31]!;
    // bit0 doubleSided + bit2 BLEND + bit128 premultiplied;bit16 是桥显式化的 receiveShadow=false,不属本合同位。
    expect(flags & (1 + 4 + 128)).toBe(1 + 4 + 128);
  });

  it("treats MASK and BLEND as a single-valued alphaMode: transparent+alphaTest is BLEND with a shadow cutoff", () => {
    const cutout = glass(material => { material.alphaTest = 0.4; });
    const projected = project(bridge(), cutout);
    expect(projected.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", alphaCutoff: 0.4, doubleSided: true });
    const opaqueMasked = mesh();
    opaqueMasked.material.alphaTest = 0.4;
    const maskProjected = project(bridge(), opaqueMasked);
    expect(maskProjected.packet.materials[0]).toMatchObject({ alphaMode: "MASK", alphaCutoff: 0.4 });
    expect(maskProjected.packet.materials[0]).not.toHaveProperty("premultipliedAlpha");
  });

  it("keeps zero-alpha transparent panes valid: fully invisible, still drawn, preserved on roundtrip", () => {
    const invisible = glass(material => { material.opacity = 0; });
    const projected = project(bridge(), invisible);
    expect(projected.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0, doubleSided: true });
    const prepared = prepareRenderPacket(projected.packet);
    expect(prepared.batches[0]).toMatchObject({ alphaMode: "BLEND", count: 1 });
    expect(prepared.batches[0]!.data[35]).toBe(0);
  });

  it("fails closed outside the support matrix with actionable features", () => {
    const back = glass(material => { material.side = THREE.BackSide; });
    reject(back, "material.BackSide");
    const depthWriting = glass(material => { material.depthWrite = true; });
    reject(depthWriting, "material transparent depthWrite");
    const opaquePremultiplied = mesh();
    opaquePremultiplied.material.premultipliedAlpha = true;
    reject(opaquePremultiplied, "material.premultipliedAlpha");
    const invalidType = glass();
    (invalidType.material as unknown as Record<string, unknown>).premultipliedAlpha = "yes";
    reject(invalidType, "material.premultipliedAlpha", "invalid");
  });

  it("declares shadow participation: BLEND is excluded while MASK casts cutoff and OPAQUE casts solid shadows", () => {
    expect(shadowMode("BLEND", true)).toBeUndefined();
    expect(shadowMode("MASK", true)).toBe("maskMaterial");
    expect(shadowMode("MASK", false)).toBe("maskPlain");
    expect(shadowMode("OPAQUE", false)).toBe("solid");
    expect(transparencySupportMatrix.depthWriteEnabled).toBe(false);
    expect(transparencySupportMatrix.shadow).toBe("none");
  });
});
