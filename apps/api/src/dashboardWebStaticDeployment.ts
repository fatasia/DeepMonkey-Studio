import { stat } from "node:fs/promises";
import path from "node:path";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import type { DashboardWebStaticDownloadDependencies } from "./dashboardOfflineArchiveDownloadRoutes.js";
import { readDashboardTrustedObject } from "./dashboardNativeCandidateRuntime.js";

export interface DashboardWebStaticDeploymentConfig {
  readonly root: string;
  readonly licensedFonts: readonly { readonly path: string; readonly licensePath: string }[];
}

export function isDashboardWebStaticDeploymentConfig(value: unknown): value is DashboardWebStaticDeploymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as DashboardWebStaticDeploymentConfig;
  return typeof config.root === "string" && path.isAbsolute(config.root)
    && Array.isArray(config.licensedFonts) && config.licensedFonts.every(font => font
      && typeof font.path === "string" && path.isAbsolute(font.path)
      && typeof font.licensePath === "string" && path.isAbsolute(font.licensePath));
}

/** 只读取候选冻结的历史发布，不能以当前草稿或新的活动版本替代。 */
export async function createDashboardWebStaticDeployment(config: DashboardWebStaticDeploymentConfig,
  store: Pick<MetadataStore, "getPublishedApplication">,
  objects: Pick<ObjectStore, "read">): Promise<DashboardWebStaticDownloadDependencies> {
  if (!isDashboardWebStaticDeploymentConfig(config)) throw new Error("Dashboard Web static deployment requires absolute paths and licensed fonts");
  if (!(await stat(config.root)).isDirectory() || !(await stat(path.join(config.root, "index.html"))).isFile())
    throw new Error("Dashboard Web static deployment requires a built index.html");
  for (const font of config.licensedFonts) {
    if (!(await stat(font.path)).isFile() || !(await stat(font.licensePath)).isFile())
      throw new Error("Dashboard Web static deployment requires font and distribution license files");
  }
  return {
    webStaticRoot: config.root,
    licensedFonts: structuredClone(config.licensedFonts),
    async readPublication({ record, signal }) {
      signal?.throwIfAborted();
      const authority = record.candidate.authority;
      const publication = store.getPublishedApplication(authority.publicationId);
      if (!publication || publication.projectId !== authority.projectId
        || publication.applicationId !== authority.applicationId
        || publication.applicationRevision !== authority.applicationRevision) return undefined;
      return structuredClone(publication);
    },
    readResourceObject: (key, signal) => readDashboardTrustedObject(objects, key, signal),
  };
}
