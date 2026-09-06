import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ROBOT_IMPORT_LIMITS } from "@bim-studio/contracts";
import type { RobotAssetDefinition, RobotGeometryDefinition, RobotJointDefinition, RobotLinkDefinition, RobotVisualDefinition } from "@bim-studio/contracts";
import { list, material, name, node, number, origin, robotArchivePath, robotResourcePath, vector, type XmlNode } from "./robotUrdfValues.js";

export const MAX_ROBOT_XML_BYTES = ROBOT_IMPORT_LIMITS.xmlBytes;

export function parseRobotUrdf(xml: string, options: { entryPath: string; availableFiles: ReadonlySet<string> }): RobotAssetDefinition {
  if (Buffer.byteLength(xml) > MAX_ROBOT_XML_BYTES) throw new Error("URDF 超过 8 MiB");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<\?(?!xml\s)[\s\S]*?\?>/i.test(xml)) throw new Error("URDF 不允许 DTD、实体声明或处理指令");
  if (XMLValidator.validate(xml) !== true) throw new Error("URDF XML 结构无效");
  robotArchivePath(options.entryPath);
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    maxNestedTags: 32, ignoreDeclaration: true, processEntities: true, htmlEntities: false,
    onDangerousProperty: (property: string) => { throw new Error(`URDF 包含保留属性：${property}`); } });
  const parsed = node(parser.parse(xml), "URDF");
  if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "robot")) throw new Error("URDF 必须只有一个 robot 根元素");
  const robot = node(parsed.robot, "robot");
  const links = list(robot.link).map(value => parseLink(value, options));
  const joints = list(robot.joint).map(parseJoint);
  if (!links.length || links.length > ROBOT_IMPORT_LIMITS.maxJoints + 1 || joints.length > ROBOT_IMPORT_LIMITS.maxJoints) throw new Error("URDF 需包含 1–513 个连杆，且最多 512 个关节");
  const rootLink = validateGraph(links, joints);
  const materials = list(robot.material).map(value => material(value, options.entryPath, options.availableFiles));
  const materialNames = new Set<string>();
  for (const item of materials) {
    if (!item.name || materialNames.has(item.name)) throw new Error("URDF 全局材质名称缺失或重复");
    materialNames.add(item.name);
  }
  for (const link of links) for (const visual of [...link.visuals, ...link.collisions]) {
    const candidate = visual.material;
    if (candidate?.name && !candidate.color && !candidate.texture && !materialNames.has(candidate.name)) throw new Error(`未定义材质：${candidate.name}`);
  }
  return { schemaVersion: 1, name: name(robot["@_name"], "robot"), entryPath: options.entryPath, rootLink, links, joints, materials, resources: [] };
}

function parseLink(value: unknown, options: { entryPath: string; availableFiles: ReadonlySet<string> }): RobotLinkDefinition {
  const link = node(value, "link");
  const result: RobotLinkDefinition = { name: name(link["@_name"], "link"),
    visuals: list(link.visual).map(item => parseVisual(item, options)), collisions: list(link.collision).map(item => parseVisual(item, options)) };
  if (result.visuals.length + result.collisions.length > 128) throw new Error("单连杆形状数量超过 128");
  if (link.inertial !== undefined) {
    const inertial = node(link.inertial, "inertial");
    const inertia = node(inertial.inertia, "inertia");
    result.inertial = { origin: origin(inertial.origin), mass: number(node(inertial.mass, "mass")["@_value"], "mass", 0),
      ixx: number(inertia["@_ixx"], "ixx", 0), ixy: number(inertia["@_ixy"], "ixy"), ixz: number(inertia["@_ixz"], "ixz"),
      iyy: number(inertia["@_iyy"], "iyy", 0), iyz: number(inertia["@_iyz"], "iyz"), izz: number(inertia["@_izz"], "izz", 0) };
  }
  return result;
}

function parseVisual(value: unknown, options: { entryPath: string; availableFiles: ReadonlySet<string> }): RobotVisualDefinition {
  const visual = node(value, "visual/collision");
  const geometry = node(visual.geometry, "geometry");
  const kinds = Object.keys(geometry);
  if (kinds.length !== 1) throw new Error("geometry 必须只包含一种形状");
  const kind = kinds[0]!;
  const input = node(geometry[kind], "geometry");
  let shape: RobotGeometryDefinition;
  if (kind === "mesh") {
    const resource = robotResourcePath(input["@_filename"], options.entryPath, options.availableFiles);
    if (!/\.(?:stl|dae|glb|gltf|obj)$/i.test(resource.resolvedPath)) throw new Error("机器人网格暂仅支持 STL、DAE、GLB、glTF、OBJ");
    shape = { type: "mesh", ...resource, scale: vector(input["@_scale"], { x: 1, y: 1, z: 1 }, "mesh.scale") };
  } else if (kind === "box") {
    if (input["@_size"] === undefined) throw new Error("box.size 缺失");
    shape = { type: "box", size: vector(input["@_size"], { x: 1, y: 1, z: 1 }, "box.size", Number.MIN_VALUE) };
  } else if (kind === "sphere") shape = { type: "sphere", radius: number(input["@_radius"], "sphere.radius", Number.MIN_VALUE) };
  else if (kind === "cylinder") shape = { type: "cylinder", radius: number(input["@_radius"], "cylinder.radius", Number.MIN_VALUE), length: number(input["@_length"], "cylinder.length", Number.MIN_VALUE) };
  else throw new Error(`不支持机器人形状：${kind}`);
  return { ...(visual["@_name"] !== undefined ? { name: name(visual["@_name"], "visual") } : {}), origin: origin(visual.origin), geometry: shape,
    ...(visual.material !== undefined ? { material: material(visual.material, options.entryPath, options.availableFiles) } : {}) };
}

function parseJoint(value: unknown): RobotJointDefinition {
  const joint = node(value, "joint");
  const type = joint["@_type"];
  if (!["fixed", "revolute", "continuous", "prismatic"].includes(String(type))) throw new Error(`暂不支持关节类型：${String(type)}`);
  const axis = vector(joint.axis === undefined ? undefined : node(joint.axis, "axis")["@_xyz"], { x: 1, y: 0, z: 0 }, "joint.axis");
  const axisLength = Math.hypot(axis.x, axis.y, axis.z);
  if (!Number.isFinite(axisLength) || axisLength < 1e-12) throw new Error("关节轴向长度必须为有限非零值");
  const result: RobotJointDefinition = { name: name(joint["@_name"], "joint"), type: type as RobotJointDefinition["type"],
    parent: name(node(joint.parent, "parent")["@_link"], "parent.link"), child: name(node(joint.child, "child")["@_link"], "child.link"), origin: origin(joint.origin), axis };
  if (joint.limit !== undefined) result.limit = readLimit(node(joint.limit, "limit"));
  if (type === "revolute" || type === "prismatic") {
    if (result.limit?.lower === undefined || result.limit.upper === undefined) throw new Error("旋转/平移关节必须明确上下限");
  }
  if (joint.mimic !== undefined) {
    if (type === "fixed") throw new Error("固定关节不能声明 mimic");
    const mimic = node(joint.mimic, "mimic");
    result.mimic = { joint: name(mimic["@_joint"], "mimic.joint"), multiplier: mimic["@_multiplier"] === undefined ? 1 : number(mimic["@_multiplier"], "mimic.multiplier"), offset: mimic["@_offset"] === undefined ? 0 : number(mimic["@_offset"], "mimic.offset") };
  }
  return result;
}

function readLimit(source: XmlNode): NonNullable<RobotJointDefinition["limit"]> {
  const limit: NonNullable<RobotJointDefinition["limit"]> = {};
  for (const key of ["lower", "upper", "effort", "velocity"] as const) if (source[`@_${key}`] !== undefined) limit[key] = number(source[`@_${key}`], `limit.${key}`, key === "effort" || key === "velocity" ? 0 : -Infinity);
  if (limit.lower !== undefined && limit.upper !== undefined && limit.lower > limit.upper) throw new Error("关节下限不能大于上限");
  return limit;
}

function validateGraph(links: RobotLinkDefinition[], joints: RobotJointDefinition[]): string {
  const linkNames = new Set(links.map(link => link.name));
  const jointByName = new Map(joints.map(joint => [joint.name, joint]));
  if (linkNames.size !== links.length || jointByName.size !== joints.length) throw new Error("连杆或关节名称重复");
  const children = new Set<string>();
  for (const joint of joints) {
    if (!linkNames.has(joint.parent) || !linkNames.has(joint.child) || children.has(joint.child)) throw new Error("关节引用缺失连杆或同一连杆有多个父关节");
    children.add(joint.child);
    const chain = new Set<string>([joint.name]);
    let current = joint;
    while (current.mimic) {
      const target = jointByName.get(current.mimic.joint);
      if (!target || target.type === "fixed" || (current.type === "prismatic") !== (target.type === "prismatic")) throw new Error("mimic 引用缺失或关节单位不兼容");
      if (chain.has(target.name)) throw new Error("mimic 依赖存在环");
      chain.add(target.name); current = target;
    }
  }
  const roots = links.filter(link => !children.has(link.name));
  if (roots.length !== 1) throw new Error("URDF 必须只有一个根连杆");
  const pending = [roots[0]!.name], visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) throw new Error("连杆拓扑存在环");
    visited.add(current);
    pending.push(...joints.filter(joint => joint.parent === current).map(joint => joint.child));
  }
  if (visited.size !== links.length) throw new Error("连杆拓扑存在环或不连通");
  return roots[0]!.name;
}
