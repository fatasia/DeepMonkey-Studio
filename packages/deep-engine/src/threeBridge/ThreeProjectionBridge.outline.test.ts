import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "../renderPacket.js";
import { INSTANCE_OUTLINE_USER_DATA_KEY } from "../postprocess/instanceOutlineCpu.js";
import { bridge, project } from "./testFixture.js";

const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());

describe("Three author outline tag → render instance outline bit", () => {
  it("projects the tag on a model root to every mesh descendant, and nothing without it", () => {
    const root = new THREE.Group(), outlined = new THREE.Group(), plain = mesh(), a = mesh(), b = mesh();
    outlined.add(a, b); root.add(outlined, plain);
    const none = project(bridge(), root).packet;
    expect(none.instances.every(instance => instance.outline === undefined)).toBe(true);
    outlined.userData[INSTANCE_OUTLINE_USER_DATA_KEY] = true;
    const tagged = project(bridge(), root).packet;
    const flags = tagged.instances.map(instance => instance.outline === true);
    expect(flags.filter(Boolean)).toHaveLength(2);
    expect(flags.filter(value => !value)).toHaveLength(1);
    // Bit 256 reaches the packed batch record without splitting the shared material batch.
    const batches = prepareRenderPacket(tagged).batches;
    const bits = batches.flatMap(batch => Array.from({ length: batch.count }, (_, index) => (batch.data[index * 36 + 31]! & 256) !== 0));
    expect(bits.filter(Boolean)).toHaveLength(2);
    outlined.userData[INSTANCE_OUTLINE_USER_DATA_KEY] = false;
    expect(project(bridge(), root).packet.instances.every(instance => instance.outline === undefined)).toBe(true);
  });

  it("honours the tag on the mesh itself (selected child object)", () => {
    const root = new THREE.Group(), selected = mesh(), other = mesh();
    root.add(selected, other); selected.userData[INSTANCE_OUTLINE_USER_DATA_KEY] = true;
    const packet = project(bridge(), root).packet;
    expect(packet.instances.filter(instance => instance.outline === true)).toHaveLength(1);
  });
});
