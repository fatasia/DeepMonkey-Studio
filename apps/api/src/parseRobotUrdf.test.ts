import { describe, expect, it } from "vitest";
import { parseRobotUrdf } from "./parseRobotUrdf.js";

const base = '<link name="base"><visual><geometry><box size="1 2 3"/></geometry></visual></link>';
const joint = '<joint name="slide" type="prismatic"><parent link="base"/><child link="tip"/><axis xyz="1 1 0"/><origin xyz="0 0 1" rpy="0 0 1.57079632679"/><limit lower="0" upper="0.4" effort="10" velocity="0.1"/></joint>';
const parse = (body: string, availableFiles = new Set(["robot.urdf"])) => parseRobotUrdf(`<robot name="fixture">${body}</robot>`, { entryPath: "robot.urdf", availableFiles });

describe("URDF structural input", () => {
  it("preserves arbitrary axes, SI origin, prismatic limits and multiple visual/collision shapes", () => {
    const result = parse(`${base}<link name="tip"><visual><geometry><sphere radius="0.2"/></geometry></visual><collision><geometry><cylinder radius="0.1" length="0.3"/></geometry></collision></link>${joint}`);
    expect(result.rootLink).toBe("base");
    expect(result.joints[0]).toMatchObject({ axis: { x: 1, y: 1, z: 0 }, origin: { xyz: { x: 0, y: 0, z: 1 } }, limit: { lower: 0, upper: .4, velocity: .1 } });
    expect(result.links[1]!.visuals[0]!.geometry.type).toBe("sphere");
    expect(result.links[1]!.collisions[0]!.geometry.type).toBe("cylinder");
  });

  it("preserves mimic, global material, local relative resources and inertial tensors", () => {
    const result = parseRobotUrdf(`<robot name="gripper"><material name="paint"><color rgba="1 0.5 0 1"/></material>${base}
      <link name="finger"><visual><geometry><mesh filename="package://pkg/meshes/finger.stl" scale="1 2 1"/></geometry><material name="paint"/></visual>
      <inertial><origin xyz="0 0 0.1"/><mass value="0.2"/><inertia ixx="1" ixy="0" ixz="0" iyy="1" iyz="0" izz="1"/></inertial></link><link name="second"/>
      <joint name="drive" type="continuous"><parent link="base"/><child link="finger"/></joint>
      <joint name="follow" type="revolute"><parent link="base"/><child link="second"/><limit lower="-1" upper="1"/><mimic joint="drive" multiplier="-1" offset="0.2"/></joint></robot>`,
    { entryPath: "pkg/urdf/robot.urdf", availableFiles: new Set(["pkg/urdf/robot.urdf", "pkg/meshes/finger.stl"]) });
    expect(result.joints[1]!.mimic).toEqual({ joint: "drive", multiplier: -1, offset: .2 });
    expect(result.links[1]!.visuals[0]!.geometry).toMatchObject({ resolvedPath: "pkg/meshes/finger.stl", scale: { x: 1, y: 2, z: 1 } });
    expect(result.links[1]!.inertial?.mass).toBe(.2);
    expect(result.materials[0]!.color).toEqual([1, .5, 0, 1]);
  });

  it.each([
    ["duplicate", `${base}${base}`], ["multiple roots", `${base}<link name="other"/>`],
    ["missing link", `${base}${joint}`], ["self cycle", `${base}<joint name="loop" type="fixed"><parent link="base"/><child link="base"/></joint>`],
    ["NaN", base.replace("1 2 3", "NaN 2 3")], ["Infinity", base.replace("1 2 3", "1e999 2 3")],
    ["negative size", base.replace("1 2 3", "-1 2 3")], ["prototype name", base.replace('name="base"', 'name="__proto__"')],
    ["selector quote", base.replace('name="base"', 'name="base&amp;quot;&quot;"')],
    ["selector bracket", base.replace('name="base"', 'name="base[0]"')],
    ["selector backslash", base.replace('name="base"', 'name="base\\part"')],
    ["unsupported joint", `${base}<link name="tip"/>${joint.replace('type="prismatic"', 'type="floating"')}`],
    ["reversed limits", `${base}<link name="tip"/>${joint.replace('lower="0"', 'lower="1"')}`],
    ["zero axis", `${base}<link name="tip"/>${joint.replace('xyz="1 1 0"', 'xyz="0 0 0"')}`],
    ["overflowing axis norm", `${base}<link name="tip"/>${joint.replace('xyz="1 1 0"', 'xyz="1.79e308 1.79e308 0"')}`],
  ])("rejects %s", (_case, body) => expect(() => parse(body)).toThrow());

  it.each(["http://example.com/part.stl", "file:///tmp/part.stl", "../part.stl", "%2e%2e/part.stl", "package://missing/part.stl"]) ("rejects missing or escaped mesh %s", filename => {
    expect(() => parse(`<link name="base"><visual><geometry><mesh filename="${filename}"/></geometry></visual></link>`)).toThrow();
  });

  it("rejects DTD/entities, malformed XML, mimic cycles and duplicate attributes", () => {
    for (const xml of ['<!DOCTYPE robot [<!ENTITY x SYSTEM "file:///secret">]><robot name="x"/>', '<robot name="x"><link></robot>', '<robot name="x" name="y"><link name="a"/></robot>']) {
      expect(() => parseRobotUrdf(xml, { entryPath: "robot.urdf", availableFiles: new Set() })).toThrow();
    }
    const common = `${base}<link name="one"/><link name="two"/>`;
    const j = (name: string, child: string, target: string) => `<joint name="${name}" type="continuous"><parent link="base"/><child link="${child}"/><mimic joint="${target}"/></joint>`;
    expect(() => parse(common + j("a", "one", "b") + j("b", "two", "a"))).toThrow("mimic");
  });
});
