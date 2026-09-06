import * as THREE from "three";
import type { ModelManifest, RobotAssetDefinition, RobotMaterialDefinition } from "@bim-studio/contracts";
import { loadViewerAssetBuffer } from "./viewerAssetTransport";
import { attachRobotRuntime } from "./robotPoseRuntime";
import { disposeViewerObject } from "./sceneOverlayVisuals";
import { readRobotPackage, ROBOT_RESOURCE_PREFIX, RobotResourceScope } from "./urdfPackageResources";
import { loadRobotMesh } from "./urdfMeshLoader";
import { assertLoadedRobotJoint, normalizeUrdfJointAxes } from "./urdfJointNormalization";

/** 按需成熟 URDF loader；等待每个网格与关联图片，不把同步 parse 当作加载完成。 */
export async function loadUrdfModel(manifest: ModelManifest): Promise<THREE.Object3D> {
  if (!manifest.robot || !manifest.geometryUrl) throw new Error("机器人素材缺少经过验证的结构清单");
  const definition = manifest.robot;
  const [{ default: URDFLoader }, bytes] = await Promise.all([
    import("urdf-loader"), loadViewerAssetBuffer(manifest.geometryUrl, "机器人素材"),
  ]);
  const scope = new RobotResourceScope(await readRobotPackage(bytes, definition, manifest.sourceFormat === "zip"));
  const manager = new THREE.LoadingManager(), errors: unknown[] = [], meshes: Promise<void>[] = [];
  const root = new THREE.Group();
  let finish!: () => void, timedOut = false;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  const timeout = setTimeout(() => { timedOut = true; errors.push(new Error("机器人关联资源加载超时，请重试")); finish(); }, 120_000);
  manager.onLoad = finish;
  manager.onError = () => { errors.push(new Error("机器人关联图片加载失败，请检查文件包")); };
  manager.setURLModifier(scope.resolve);
  manager.itemStart("robot:parse");
  try {
    const source = new TextDecoder().decode(scope.bytes(definition.entryPath));
    const document = prepareRobotDocument(source, definition);
    const loader = new URDFLoader(manager);
    loader.parseVisual = true; loader.parseCollision = false;
    loader.packages = () => { throw new Error("机器人包路径未解析"); };
    loader.loadMeshCb = (path, loadingManager, material, done) => {
      const key = `robot:mesh:${meshes.length}`; loadingManager.itemStart(key);
      meshes.push(loadRobotMesh(path, loadingManager, material, scope).then(object => {
        if (timedOut) disposeViewerObject(object);
        else done(object);
      }).catch(error => { errors.push(error); }).finally(() => loadingManager.itemEnd(key)));
    };
    const robot = loader.parse(document);
    const coordinateRoot = new THREE.Group(); coordinateRoot.name = "URDF Z-up";
    coordinateRoot.rotation.x = -Math.PI / 2; coordinateRoot.add(robot); root.add(coordinateRoot);
    validateLoadedRobot(robot, definition);
    attachRobotRuntime(root, robot, definition);
  } catch (error) { errors.push(error); }
  finally { manager.itemEnd("robot:parse"); }
  await ready;
  clearTimeout(timeout);
  if (!timedOut) await Promise.all(meshes);
  // 图片已经 decode 完成；失败/超时路径也释放本次创建的所有 URL。
  scope.dispose();
  if (errors.length) { disposeViewerObject(root); throw new Error(errorMessage(errors[0]), { cause: errors[0] }); }
  applyRobotPbrMaterials(root);
  root.updateWorldMatrix(true, true);
  return root;
}

function prepareRobotDocument(source: string, definition: RobotAssetDefinition): Document {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error("机器人 URDF 不支持外部实体");
  const document = new DOMParser().parseFromString(source, "text/xml");
  if (document.querySelector("parsererror") || document.documentElement.nodeName !== "robot") throw new Error("机器人 URDF XML 无效");
  normalizeUrdfJointAxes(document, definition);
  const paths = new Map<string, string>();
  const add = (filename: string, resolved: string) => {
    if (paths.has(filename) && paths.get(filename) !== resolved) throw new Error("机器人资源路径存在歧义");
    paths.set(filename, resolved);
  };
  const material = (value: RobotMaterialDefinition | undefined) => { if (value?.texture) add(value.texture.filename, value.texture.resolvedPath); };
  for (const link of definition.links) for (const visual of [...link.visuals, ...link.collisions]) {
    if (visual.geometry.type === "mesh") add(visual.geometry.filename, visual.geometry.resolvedPath);
    material(visual.material);
  }
  definition.materials.forEach(material);
  for (const element of document.querySelectorAll("mesh, texture")) {
    const filename = element.getAttribute("filename");
    if (!filename && element.nodeName === "texture") continue;
    const resolved = filename && paths.get(filename);
    if (!resolved) throw new Error("机器人 URDF 引用了清单外资源");
    element.setAttribute("filename", ROBOT_RESOURCE_PREFIX + resolved);
  }
  return document;
}

function validateLoadedRobot(robot: import("urdf-loader").URDFRobot, definition: RobotAssetDefinition): void {
  if (Object.keys(robot.joints).length !== definition.joints.length || Object.keys(robot.links).length !== definition.links.length || robot.name !== definition.rootLink) throw new Error("机器人结构与资源清单不一致");
  for (const joint of definition.joints) {
    const loaded = robot.joints[joint.name];
    if (!loaded || loaded.jointType !== joint.type || loaded.parent?.name !== joint.parent || loaded.children[0]?.name !== joint.child) throw new Error("机器人关节与资源清单不一致");
    assertLoadedRobotJoint(loaded, joint);
  }
}

function applyRobotPbrMaterials(root: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.Material>();
  root.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true; child.receiveShadow = true;
    const convert = (material: THREE.Material) => {
      if (!(material instanceof THREE.MeshPhongMaterial)) return material;
      const existing = converted.get(material); if (existing) return existing;
      const result = new THREE.MeshStandardMaterial({ color: material.color, map: material.map, normalMap: material.normalMap,
        opacity: material.opacity, transparent: material.transparent, side: material.side, depthWrite: material.depthWrite,
        roughness: 0.58, metalness: 0.12 });
      result.name = material.name; converted.set(material, result); material.dispose(); return result;
    };
    child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material);
  });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "机器人素材加载失败，请检查文件包后重试"; }
