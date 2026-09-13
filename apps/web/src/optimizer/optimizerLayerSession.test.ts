import { Document, WebIO } from "@gltf-transform/core";
import { cloneDocument } from "@gltf-transform/functions";
import { describe, expect, it } from "vitest";
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from "three";
import { OptimizerLayerSession, LAYER_SESSION_MAX_FILE_BYTES } from "./optimizerLayerSession";
import { syncOptimizerLayerPreview } from "./optimizerLayerPreview";
import { editOptimizerDocument } from "./optimizerLayers";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

function fixture() {
  const doc = new Document(), buffer = doc.createBuffer();
  const positions = doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions));
  const parent = doc.createNode("组");
  parent.addChild(doc.createNode("泵").setMesh(mesh));
  doc.createScene().addChild(parent).addChild(doc.createNode("电机").setMesh(mesh));
  return doc;
}

describe("optimizer retained layer session", () => {
  it("keeps serialized graph properties and geometry independent from the immutable original", () => {
    const source = fixture(), copy = cloneDocument(source);
    expect(copy.getRoot().listAccessors()[0]!.getArray()).not.toBe(source.getRoot().listAccessors()[0]!.getArray());
    copy.getRoot().listNodes()[0]!.setName("changed").dispose();
    expect(source.getRoot().listNodes()[0]!.getName()).toBe("组");
    expect(source.getRoot().listNodes()).toHaveLength(3);
  });

  it("keeps rename, hidden subtree, delete, undo and failed edits isolated until serialization", async () => {
    const io = new WebIO(), original = await io.writeBinary(fixture()) as Uint8Array<ArrayBuffer>;
    const session = new OptimizerLayerSession(io);
    expect(await session.open("a", new File([original], "a.glb"))).toBe(true);
    const first = await session.draft([{ id: 1, action: "rename", name: "主泵" }], true);
    expect(first.previewBinary).toBeDefined();
    const hidden = await session.draft([{ id: 0, action: "hidden", hidden: true }], false);
    expect(hidden.layers.filter(layer => layer.hidden)).toHaveLength(2);
    expect(hidden.previewBinary).toBeUndefined();
    await expect(session.draft([{ id: 900, action: "delete" }], false)).rejects.toThrow("图层已不存在");
    const deleted = await session.materialize([{ id: 0, action: "delete" }]);
    expect((await io.readBinary(deleted.binary)).getRoot().listNodes()).toHaveLength(1);
    const undone = await session.materialize([]);
    const restored = await io.readBinary(undone.binary);
    expect(restored.getRoot().listNodes().map(node => node.getName())).toEqual(["组", "泵", "电机"]);
    expect(restored.getRoot().listMeshes()).toHaveLength(1);
    expect((await io.readBinary(original)).getRoot().listNodes()[1]!.getName()).toBe("泵");
    session.clear();
    await expect(session.draft([], false)).rejects.toThrow("缓存已释放");
  });

  it("drops the previous source when another source or a cache limit is encountered", async () => {
    const io = new WebIO(), session = new OptimizerLayerSession(io);
    const original = await io.writeBinary(fixture()) as Uint8Array<ArrayBuffer>;
    await session.open("a", new File([original], "a.glb"));
    expect(await session.open("a")).toBe(false);
    await expect(session.open("b", { size: LAYER_SESSION_MAX_FILE_BYTES + 1 } as File)).rejects.toThrow("64 MB");
    await expect(session.materialize([])).rejects.toThrow("缓存已释放");
    await session.open("c", new File([original], "c.glb"));
    expect((await session.draft([], true)).layers).toHaveLength(3);
  });

  it("matches persisted layer semantics, including imported hidden parents and descendants", async () => {
    const io = new WebIO(), document = fixture();
    editOptimizerDocument(document, [{ id: 0, action: "hidden", hidden: true }, { id: 1, action: "hidden", hidden: true }]);
    const session = new OptimizerLayerSession(io);
    await session.open("hidden", new File([await io.writeBinary(document) as Uint8Array<ArrayBuffer>], "hidden.glb"));
    const initial = await session.draft([], true);
    const preview = await new GLTFLoader().parseAsync(initial.previewBinary!.buffer, "");
    expect(preview.scene.children).toHaveLength(2);
    syncOptimizerLayerPreview(preview.scene, initial.layers);
    const group = preview.scene.children.find(node => node.name === "组")!;
    expect(group.visible).toBe(false);
    const commands = [{ id: 0, action: "hidden", hidden: false }, { id: 2, action: "rename", name: "主电机" }] as const;
    const shown = await session.draft(commands, false), saved = await session.materialize(commands);
    expect(shown.layers).toEqual(saved.layers);
    syncOptimizerLayerPreview(preview.scene, shown.layers);
    expect(group.visible).toBe(true); expect(group.children[0]!.visible).toBe(false);
    const reloaded = await io.readBinary(saved.binary);
    expect(reloaded.getRoot().listNodes().find(node => node.getName() === "主电机")).toBeDefined();
  });

  it("updates the real Three nodes and restores them without replacing geometry or parentage", () => {
    const root = new Group(), parent = new Group(), child = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    parent.userData.studioOptimizerLayer = { id: "layer-0" };
    child.userData.studioOptimizerLayer = { id: "layer-1" };
    parent.add(child); root.add(parent);
    const geometry = child.geometry;
    const base = [{ id: 0, name: "组", depth: 0, hidden: false, deleted: false, mesh: false }, { id: 1, name: "泵", depth: 1, parentId: 0, hidden: false, deleted: false, mesh: true }];
    syncOptimizerLayerPreview(root, base.map(layer => ({ ...layer, deleted: true })));
    expect(parent.visible).toBe(false);
    syncOptimizerLayerPreview(root, base);
    expect(child.visible).toBe(true); expect(child.name).toBe("泵");
    expect(child.parent).toBe(parent); expect(child.geometry).toBe(geometry);
    child.geometry.dispose(); (child.material as MeshBasicMaterial).dispose();
  });
});
