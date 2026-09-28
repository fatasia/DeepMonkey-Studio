import { validateDeepAssetPackage, type DeepAssetPackage, type RenderPacket } from "@bim-studio/deep-engine";
import { decideHlodFrame, decodeHlodProxyGeometries, hlodTreeFromManifest, parseHlodPackageManifest,
  type ClusterLodCamera, type HlodPackageManifest } from "@bim-studio/deep-engine/hlod";
import { parseGlb } from "@bim-studio/deep-engine/gltf";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";

export interface WebHlodPackage {
  readonly manifest: HlodPackageManifest;
  readonly proxies: ReturnType<typeof decodeHlodProxyGeometries>;
  readonly geometryHash: string;
}
export interface WebHlodBinding {
  readonly instanceIdsByNode: ReadonlyMap<string, readonly string[]>;
  readonly proxyGeometryIds: ReadonlyMap<string, string>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

/** An incomplete optional HLOD package must never replace the original engineering geometry. */
export async function loadWebHlodPackage(packageUrl: string,
  load: (url: string, signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal): Promise<WebHlodPackage> {
  signal.throwIfAborted();
  const base = new URL(packageUrl, globalThis.location?.href ?? "http://localhost/");
  if (!base.pathname.endsWith("/output/deep-package.json")) throw new Error("HLOD 包路径非法");
  const envelope = JSON.parse(new TextDecoder().decode(await load(base.href, signal))) as { package?: DeepAssetPackage };
  const checked = validateDeepAssetPackage(envelope?.package);
  if (!checked.valid || !checked.value) throw new Error("HLOD 资产包校验失败");
  const resources = checked.value.manifest.resources;
  const geometryHash = resources.find(item => item.id === "geometry:main")?.blobHash;
  if (!geometryHash) throw new Error("HLOD 资产包缺少原始几何身份");
  async function sidecar(id: string, suffix: RegExp): Promise<Uint8Array> {
    const resource = resources.find(item => item.id === id);
    if (!resource || !suffix.test(resource.logicalPath)) throw new Error(`HLOD 资源 ${id} 缺失或路径非法`);
    const url = new URL(resource.logicalPath.slice("output/".length), base);
    if (url.origin !== base.origin) throw new Error("HLOD 资源跨源");
    const bytes = await load(url.href, signal);
    signal.throwIfAborted();
    if (await sha256(bytes) !== resource.blobHash) throw new Error(`HLOD 资源 ${id} 哈希不一致`);
    return bytes;
  }
  const [manifestBytes, proxyBytes] = await Promise.all([
    sidecar("metadata:hlod-manifest", /^output\/hlod-manifest-[a-f0-9]{64}\.json$/),
    sidecar("mesh:hlod-proxies", /^output\/hlod-proxies-[a-f0-9]{64}\.bin$/),
  ]);
  const manifest = parseHlodPackageManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
  const proxies = decodeHlodProxyGeometries(proxyBytes);
  const ids = new Set(proxies.map(item => item.id));
  if (ids.size !== manifest.proxies.length || manifest.proxies.some(item => !ids.has(item.geometryId))) {
    throw new Error("HLOD 代理几何与包清单不一致");
  }
  return { manifest, proxies, geometryHash };
}

export async function verifyWebHlodGeometry(bytes: Uint8Array, packageValue: WebHlodPackage): Promise<void> {
  if (await sha256(bytes) !== packageValue.geometryHash) throw new Error("HLOD 包与当前 GLB 内容哈希不一致");
}

/** API groups mesh primitives by tree path, while Web addresses each primitive by glTF node index. */
export function bindWebHlodPackage(bytes: Uint8Array, packet: RenderPacket, manifest: HlodPackageManifest,
  modelId: string, assetId: string): WebHlodBinding {
  const doc = parseGlb(bytes).json as { scene?: number; scenes?: { nodes?: number[] }[];
    nodes?: { name?: string; mesh?: number; children?: number[] }[] };
  if (!doc.scenes?.length || (doc.scene !== undefined && doc.scene !== 0) || !doc.nodes) {
    throw new Error("HLOD 包与 Web glTF 场景索引不一致");
  }
  const prefix = `model-${runtimeContentSha256(modelId)}/asset-${runtimeContentSha256(assetId)}/node/`;
  const authored = new Set(packet.objectBindings?.find(binding => binding.nodeId === modelId)?.instanceIds ?? []);
  if (!authored.size) throw new Error("HLOD 作者对象未出现在渲染包中");
  const byNode = new Map<string, readonly string[]>(), mapped = new Set<string>(), visited = new Set<number>();
  const walk = (index: number, path: string): void => {
    const node = doc.nodes![index];
    if (!node || visited.has(index)) throw new Error("HLOD glTF 节点循环或引用非法");
    visited.add(index);
    if (node.mesh !== undefined) {
      const apiId = `node:${path}${node.name ? `:${node.name}` : ""}`;
      const marker = `${prefix}${index}/primitive/`;
      const ids = packet.instances.filter(instance => instance.id.startsWith(marker) && authored.has(instance.id))
        .map(instance => instance.id);
      if (ids.length) {
        byNode.set(apiId, ids);
        for (const id of ids) mapped.add(id);
      }
    }
    node.children?.forEach((child, childIndex) => walk(child, `${path}.${childIndex}`));
  };
  doc.scenes[0]!.nodes?.forEach((index, rootIndex) => walk(index, String(rootIndex)));
  const expected = manifest.nodes.filter(node => node.children.length === 0).flatMap(node => node.instanceIds);
  if (expected.length !== byNode.size || expected.some(id => !byNode.has(id)) || mapped.size !== authored.size) {
    throw new Error("HLOD GLB 节点与 Web 渲染实例不匹配；保持原几何渲染");
  }
  return { instanceIdsByNode: byNode,
    proxyGeometryIds: new Map(manifest.proxies.map(item => [item.nodeId, item.geometryId])) };
}

/** Opt-in draw decisions only; proxies must never enter objectBindings or engineering measurement. */
export function decideWebHlodDraws(bundle: WebHlodPackage, binding: WebHlodBinding, camera: ClusterLodCamera,
  previousCollapsed?: ReadonlySet<string>) {
  const tree = hlodTreeFromManifest(bundle.manifest);
  const decision = decideHlodFrame(tree, camera, bundle.manifest.decision, previousCollapsed);
  const hidden = new Set<string>();
  for (const collapsed of decision.collapsedNodes) {
    const ids = tree.nodes.get(collapsed.nodeId)?.instanceIds;
    if (!ids) throw new Error("HLOD 折叠节点缺失");
    for (const id of ids) {
      const instances = binding.instanceIdsByNode.get(id);
      if (!instances?.length) throw new Error(`HLOD 实例 ${id} 缺少 Web 映射`);
      for (const instance of instances) hidden.add(instance);
    }
  }
  const proxyDraws = decision.collapsedNodes.map(item => {
    const geometryId = binding.proxyGeometryIds.get(item.nodeId);
    if (!geometryId) throw new Error("HLOD 折叠节点无代理几何");
    return { nodeId: item.nodeId, geometryId };
  });
  return { proxyDraws, hiddenInstanceIds: hidden, decision };
}
