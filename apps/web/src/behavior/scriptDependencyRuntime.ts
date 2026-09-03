import type { ApplicationScriptDependency } from "@bim-studio/contracts";
import type { SceneBehaviorDependencyModule } from "@bim-studio/scene-sdk";

const MAX_CACHED_DEPENDENCIES = 128;
const dependencyCodeCache = new Map<string, string>();

export type ScriptDependencyReader = (projectId: string, dependencyId: string) => Promise<string>;

/**
 * 读取项目内已锁定的依赖代码。运行时不访问 npm 或外部 URL，
 * 因此编辑预览、Web 发布和离线客户端使用同一份内容。
 */
export async function loadScriptDependencyModules(
  projectId: string,
  dependencies: readonly ApplicationScriptDependency[],
  read: ScriptDependencyReader,
): Promise<SceneBehaviorDependencyModule[]> {
  return Promise.all(dependencies.map(async (dependency) => ({
    specifier: dependency.specifier,
    code: await readCachedDependency(projectId, dependency, read),
    integrity: dependency.integrity,
  })));
}

export function clearScriptDependencyRuntimeCache(): void {
  dependencyCodeCache.clear();
}

async function readCachedDependency(
  projectId: string,
  dependency: ApplicationScriptDependency,
  read: ScriptDependencyReader,
): Promise<string> {
  const cacheKey = `${projectId}:${dependency.id}:${dependency.integrity}`;
  const cached = dependencyCodeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const code = await read(projectId, dependency.id);
  if (!code.trim()) throw new Error(`项目依赖 ${dependency.specifier} 内容为空，请重新安装`);
  dependencyCodeCache.set(cacheKey, code);
  trimCache();
  return code;
}

function trimCache(): void {
  while (dependencyCodeCache.size > MAX_CACHED_DEPENDENCIES) {
    const oldest = dependencyCodeCache.keys().next().value as string | undefined;
    if (!oldest) return;
    dependencyCodeCache.delete(oldest);
  }
}
