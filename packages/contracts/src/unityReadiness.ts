import type {
  ApplicationDocument,
  DashboardDataWidgetConfig,
  DashboardDataWidgetNode,
  UnityResourceRecord,
  UnityResourceVersionRecord,
} from "./index.js";

export type UnityReadinessSeverity = "blocker" | "warning";
export interface UnityReadinessIssue {
  code:
    | "missing-runtime"
    | "missing-resource"
    | "missing-version"
    | "unsupported-version"
    | "missing-scenes"
    | "unknown-scene"
    | "unknown-layer"
    | "unbound-layer"
    | "unknown-action"
    | "unknown-object"
    | "unknown-property"
    | "missing-health-contract"
    | "suboptimal-compression"
    | "large-build"
    | "import-diagnostic"
    | "external-runtime";
  severity: UnityReadinessSeverity;
  pageId: string;
  nodeId: string;
  zh: string;
  en: string;
}

export function assessUnityApplicationReadiness(
  application: Pick<ApplicationDocument, "pages">,
  resources: readonly UnityResourceRecord[],
): UnityReadinessIssue[] {
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const issues: UnityReadinessIssue[] = [];
  for (const page of application.pages) {
    const widgets = page.nodes.filter(
      (node): node is DashboardDataWidgetNode => node.kind === "data-widget" && node.widget.type === "unity",
    );
    for (const node of widgets)
      issues.push(...assessUnityWidgetReadiness(node.widget, resources, page.id, node.id, resourceById));
  }
  const rank = { blocker: 0, warning: 1 } satisfies Record<UnityReadinessSeverity, number>;
  return issues.sort(
    (left, right) =>
      rank[left.severity] - rank[right.severity] ||
      left.pageId.localeCompare(right.pageId) ||
      left.nodeId.localeCompare(right.nodeId) ||
      left.code.localeCompare(right.code),
  );
}

export function assessUnityWidgetReadiness(
  widget: DashboardDataWidgetConfig,
  resources: readonly UnityResourceRecord[],
  pageId = "current",
  nodeId = "unity",
  existingIndex?: ReadonlyMap<string, UnityResourceRecord>,
): UnityReadinessIssue[] {
  const issues: UnityReadinessIssue[] = [];
  const resourceId = widget.unityResourceId?.trim();
  if (!resourceId) {
    if (!validHttpUrl(widget.unityUrl))
      issues.push(
        issue(
          "missing-runtime",
          "blocker",
          pageId,
          nodeId,
          "Unity 组件没有可发布的资源或 HTTP(S) 播放地址。",
          "The Unity widget has no publishable resource or HTTP(S) player URL.",
        ),
      );
    else
      issues.push(
        issue(
          "external-runtime",
          "warning",
          pageId,
          nodeId,
          "Unity 使用外部托管地址，发布前需单独验证 HTTPS、CSP、缓存和跨域消息来源。",
          "Unity uses external hosting; validate HTTPS, CSP, caching, and the message origin before publication.",
        ),
      );
    return issues;
  }
  const resource = existingIndex?.get(resourceId) ?? resources.find((candidate) => candidate.id === resourceId);
  if (!resource)
    return [
      issue(
        "missing-resource",
        "blocker",
        pageId,
        nodeId,
        `Unity 资源“${resourceId}”不存在或已删除。`,
        `Unity resource “${resourceId}” is missing or deleted.`,
      ),
    ];
  const version = selectedVersion(resource, widget.unityResourceVersionId);
  if (!version)
    return [
      issue(
        "missing-version",
        "blocker",
        pageId,
        nodeId,
        "Unity 组件引用的资源版本不存在。",
        "The Unity widget references a missing resource version.",
      ),
    ];
  assessManagedVersion(pageId, nodeId, widget, version, issues);
  return issues;
}

function assessManagedVersion(
  pageId: string,
  nodeId: string,
  widget: DashboardDataWidgetConfig,
  version: UnityResourceVersionRecord,
  issues: UnityReadinessIssue[],
): void {
  const manifest = version.manifest;
  if (!supportedUnityVersion(manifest.unityVersion))
    issues.push(
      issue(
        "unsupported-version",
        "blocker",
        pageId,
        nodeId,
        manifest.unityVersion
          ? `Unity ${manifest.unityVersion} 不在当前发布门禁（仅 2022.3 LTS / 6000.0）。`
          : "Unity 构建没有声明版本，无法确认 2022.3/6000.0 兼容性。",
        manifest.unityVersion
          ? `Unity ${manifest.unityVersion} is outside the current publication gate (2022.3 LTS / 6000.0 only).`
          : "The Unity build does not declare a version, so 2022.3/6000.0 compatibility cannot be confirmed.",
      ),
    );
  if (!manifest.scenes?.length)
    issues.push(
      issue(
        "missing-scenes",
        "blocker",
        pageId,
        nodeId,
        "Unity manifest 没有声明场景，无法验证运行入口。",
        "The Unity manifest declares no scenes, so the runtime entry cannot be verified.",
      ),
    );
  if (widget.unityScene && !manifest.scenes?.includes(widget.unityScene))
    issues.push(
      issue(
        "unknown-scene",
        "blocker",
        pageId,
        nodeId,
        `当前场景“${widget.unityScene}”不在资源版本中。`,
        `Current scene “${widget.unityScene}” is not present in this resource version.`,
      ),
    );
  const layers = new Set((manifest.dataLayers ?? []).map((layer) => layer.key));
  for (const binding of widget.unityDataBindings ?? [])
    if (!layers.has(binding.layerKey))
      issues.push(
        issue(
          "unknown-layer",
          "blocker",
          pageId,
          nodeId,
          `数据层绑定“${binding.layerKey}”不在当前 manifest 中。`,
          `Data-layer binding “${binding.layerKey}” is not declared by the current manifest.`,
        ),
      );
  for (const layer of manifest.dataLayers ?? [])
    if (!widget.unityDataBindings?.some((binding) => binding.layerKey === layer.key && binding.dataKey.trim()))
      issues.push(
        issue(
          "unbound-layer",
          "warning",
          pageId,
          nodeId,
          `数据层“${layer.key}”尚未绑定平台数据。`,
          `Data layer “${layer.key}” is not bound to platform data.`,
        ),
      );
  if (widget.unityDefaultAction && !manifest.actions?.includes(widget.unityDefaultAction.action))
    issues.push(
      issue(
        "unknown-action",
        "blocker",
        pageId,
        nodeId,
        `默认动作“${widget.unityDefaultAction.action}”不在当前 manifest 中。`,
        `Default action “${widget.unityDefaultAction.action}” is not declared by the current manifest.`,
      ),
    );
  if (
    widget.unityDefaultAction?.objectId &&
    !manifest.objects?.some((object) => object.id === widget.unityDefaultAction?.objectId)
  )
    issues.push(
      issue(
        "unknown-object",
        "blocker",
        pageId,
        nodeId,
        `默认对象“${widget.unityDefaultAction.objectId}”不在当前 manifest 中。`,
        `Default object “${widget.unityDefaultAction.objectId}” is not declared by the current manifest.`,
      ),
    );
  const properties = new Set((manifest.properties ?? []).map((property) => property.key));
  for (const key of Object.keys(widget.unityPropertyValues ?? {}))
    if (!properties.has(key))
      issues.push(
        issue(
          "unknown-property",
          "blocker",
          pageId,
          nodeId,
          `属性“${key}”不在当前 manifest 中。`,
          `Property “${key}” is not declared by the current manifest.`,
        ),
      );
  const runtimeCapabilities = new Set(manifest.runtimeCapabilities ?? []);
  if (!runtimeCapabilities.has("ack") || !runtimeCapabilities.has("heartbeat"))
    issues.push(
      issue(
        "missing-health-contract",
        "warning",
        pageId,
        nodeId,
        "当前 Unity 构建不回传消息确认与运行心跳；可以发布，但运行中断只能依赖超时发现。",
        "This Unity build does not report message acknowledgements and runtime heartbeats; it can publish, but interruptions are detected only by timeout.",
      ),
    );
  if (manifest.webBuild && !["brotli", "gzip"].includes(manifest.webBuild.compression))
    issues.push(
      issue(
        "suboptimal-compression",
        "warning",
        pageId,
        nodeId,
        manifest.webBuild.compression === "decompression-fallback"
          ? "Unity 构建使用浏览器端解压回退，会增加启动耗时和内存占用。"
          : "Unity 构建未使用一致的原生 Brotli/Gzip 传输压缩。",
        manifest.webBuild.compression === "decompression-fallback"
          ? "The Unity build uses browser-side decompression fallback, increasing startup time and memory use."
          : "The Unity build does not use consistent native Brotli/Gzip transfer compression.",
      ),
    );
  if (version.size > 256 * 1024 * 1024 || version.fileCount > 5_000 || (manifest.webBuild?.runtimePayloadBytes ?? 0) > 256 * 1024 * 1024)
    issues.push(
      issue(
        "large-build",
        "warning",
        pageId,
        nodeId,
        `Unity 构建较大（${Math.ceil(version.size / 1024 / 1024)} MiB / ${version.fileCount} 文件），发布前需要完成缓存、压缩响应头和启动性能验证。`,
        `The Unity build is large (${Math.ceil(version.size / 1024 / 1024)} MiB / ${version.fileCount} files); validate caching, compression headers, and startup performance before release.`,
      ),
    );
  for (const diagnostic of version.diagnostics)
    issues.push(issue("import-diagnostic", "warning", pageId, nodeId, diagnostic, diagnostic));
}

function selectedVersion(resource: UnityResourceRecord, versionId?: string): UnityResourceVersionRecord | undefined {
  return resource.versions.find((version) => version.id === (versionId || resource.activeVersionId));
}

function supportedUnityVersion(value?: string): boolean {
  const normalized = value?.trim().replace(/^unity\s*/i, "") ?? "";
  return normalized.startsWith("2022.3") || normalized.startsWith("6000.0");
}

function validHttpUrl(value?: string): boolean {
  try {
    return (
      ["http:", "https:"].includes(new URL(value ?? "", "https://studio.invalid/").protocol) && Boolean(value?.trim())
    );
  } catch {
    return false;
  }
}

function issue(
  code: UnityReadinessIssue["code"],
  severity: UnityReadinessSeverity,
  pageId: string,
  nodeId: string,
  zh: string,
  en: string,
): UnityReadinessIssue {
  return { code, severity, pageId, nodeId, zh, en };
}
