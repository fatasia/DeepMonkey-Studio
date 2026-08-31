import type {
  ApplicationDocument, DashboardDataWidgetConfig, JsonValue, ProjectRecord, UnityBuildManifestRecord,
} from "@bim-studio/contracts";
import type { SceneCommand } from "@bim-studio/scene-sdk";

export type UnitySceneCommand = Extract<SceneCommand, { type: `unity.${string}` }>;

export function isUnitySceneCommand(command: SceneCommand): command is UnitySceneCommand {
  return command.type.startsWith("unity.");
}

interface UnityScriptCommandHostOptions {
  application: ApplicationDocument;
  project?: ProjectRecord;
  updateWidget: (componentId: string, widget: Partial<DashboardDataWidgetConfig>) => void;
  dispatchAction: (detail: { widgetId: string; action: string; objectId?: string; value?: JsonValue }) => void;
}

/**
 * 执行脚本发出的 Unity 命令。所有键、动作、对象和场景都必须来自构建清单，
 * 避免脚本绕过图形化配置直接调用 Unity 内部实现。
 */
export function executeUnityScriptCommand(command: UnitySceneCommand, options: UnityScriptCommandHostOptions): void {
  const { node, widget } = findUnityWidget(options.application, command.componentId);
  const manifest = resolveManifest(widget, options.project);

  if (command.type === "unity.properties.set") {
    const allowed = new Set(manifest?.properties?.map((property) => property.key) ?? Object.keys(widget.unityPropertyValues ?? {}));
    for (const key of Object.keys(command.values)) requireAllowed(allowed, key, "属性");
    options.updateWidget(node.id, {
      unityPropertyValues: { ...(widget.unityPropertyValues ?? {}), ...command.values },
    });
    return;
  }

  if (command.type === "unity.scene.switch") {
    const allowed = new Set(manifest?.scenes ?? widget.unityScenes ?? []);
    requireAllowed(allowed, command.scene, "场景");
    options.updateWidget(node.id, { unityScene: command.scene });
    return;
  }

  const actions = new Set(manifest?.actions ?? (widget.unityDefaultAction ? [widget.unityDefaultAction.action] : []));
  requireAllowed(actions, command.action, "动作");
  if (command.objectId) {
    const objects = new Set(manifest?.objects?.map((object) => object.id) ?? []);
    requireAllowed(objects, command.objectId, "对象");
  }
  options.dispatchAction({
    widgetId: node.id,
    action: command.action,
    ...(command.objectId ? { objectId: command.objectId } : {}),
    ...(command.value === undefined ? {} : { value: command.value }),
  });
}

function findUnityWidget(application: ApplicationDocument, idOrName: string) {
  const entry = application.pages
    .flatMap((page) => page.nodes)
    .find((node) => node.id === idOrName || node.name === idOrName);
  if (!entry) throw new Error(`找不到 Unity 组件“${idOrName}”`);
  if (entry.kind !== "data-widget" || entry.widget.type !== "unity")
    throw new Error(`组件“${idOrName}”不是 Unity 组件`);
  return { node: entry, widget: entry.widget };
}

function resolveManifest(widget: DashboardDataWidgetConfig, project?: ProjectRecord): UnityBuildManifestRecord | undefined {
  const resource = project?.unityResources?.find((candidate) => candidate.id === widget.unityResourceId);
  const version = resource?.versions.find((candidate) => candidate.id === widget.unityResourceVersionId)
    ?? resource?.versions.find((candidate) => candidate.id === resource.activeVersionId);
  return version?.manifest;
}

function requireAllowed(allowed: ReadonlySet<string>, value: string, label: string): void {
  if (!allowed.has(value)) throw new Error(`Unity ${label}“${value}”未在当前构建清单中声明`);
}
