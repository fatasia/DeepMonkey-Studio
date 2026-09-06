import * as THREE from "three";
import { ROBOT_RESOURCE_PREFIX, RobotResourceScope, safeRobotPath } from "./urdfPackageResources";
import { prepareRobotGltf } from "./urdfGltfResources";

export async function loadRobotMesh(path: string, manager: THREE.LoadingManager, material: THREE.Material, scope: RobotResourceScope): Promise<THREE.Object3D> {
  if (!path.startsWith(ROBOT_RESOURCE_PREFIX)) throw new Error("机器人网格必须来自当前文件包");
  const resource = safeRobotPath(path.slice(ROBOT_RESOURCE_PREFIX.length)), bytes = scope.bytes(resource);
  const extension = resource.split(".").at(-1)?.toLowerCase();
  if (extension === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    return new THREE.Mesh(new STLLoader(manager).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), material);
  }
  if (extension === "obj") {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    const source = new TextDecoder().decode(bytes);
    if (/^\s*mtllib\s+/m.test(source)) throw new Error("机器人 OBJ 暂不读取 MTL，请使用 URDF 材质或 GLB");
    const object = new OBJLoader(manager).parse(source);
    object.traverse(child => { if (child instanceof THREE.Mesh) { for (const current of Array.isArray(child.material) ? child.material : [child.material]) current.dispose(); child.material = material; } });
    return object;
  }
  if (extension === "dae") {
    const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
    const source = new TextDecoder().decode(bytes), base = resource.includes("/") ? resource.slice(0, resource.lastIndexOf("/") + 1) : "";
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error("机器人 DAE 不支持外部实体");
    const document = new DOMParser().parseFromString(source, "text/xml");
    if (document.querySelector("parsererror")) throw new Error("机器人 DAE XML 无效");
    for (const image of document.querySelectorAll("library_images image init_from")) scope.bytes(safeRobotPath(base + (image.textContent?.trim() ?? "")));
    const result = new ColladaLoader(manager).parse(source, ROBOT_RESOURCE_PREFIX + base);
    if (!result) throw new Error("机器人 DAE 无可加载场景");
    return result.scene;
  }
  if (extension === "glb" || extension === "gltf") {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    return (await new GLTFLoader(manager).parseAsync(prepareRobotGltf(bytes, resource, scope), "")).scene;
  }
  throw new Error(`机器人网格格式暂不支持：${extension ?? "未知"}`);
}
