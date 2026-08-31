import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectAssetRecord } from "@bim-studio/contracts";
import { DEFAULT_ENVIRONMENT } from "../appDefaults";
import {
  environmentPatchFromProjectAsset,
  materialPatchFromProjectAsset,
  ProjectEnvironmentResourcePicker,
  ProjectMaterialResourcePicker,
} from "./ProjectAppearanceResources";

const now = new Date(0).toISOString();
const material: ProjectAssetRecord = {
  id: "material-1", projectId: "default", kind: "pbr-material", name: "工业钢板", fileName: "steel.pbr",
  mimeType: "application/x-bim-pbr-material", size: 30, url: "/assets/base.jpg", thumbnailUrl: "/assets/thumb.png",
  maps: [
    { kind: "base-color", name: "base.jpg", mimeType: "image/jpeg", size: 10, url: "/assets/base.jpg", contentHash: "base" },
    { kind: "normal", name: "normal.jpg", mimeType: "image/jpeg", size: 10, url: "/assets/normal.jpg", contentHash: "normal" },
    { kind: "roughness", name: "rough.jpg", mimeType: "image/jpeg", size: 10, url: "/assets/rough.jpg", contentHash: "rough" },
  ],
  createdAt: now, updatedAt: now,
};
const environment: ProjectAssetRecord = {
  ...material, id: "environment-1", kind: "environment", name: "车间晨光", fileName: "environment.hdr", mimeType: "image/vnd.radiance", url: "/assets/environment.hdr",
  maps: [{ kind: "environment", name: "environment.hdr", mimeType: "image/vnd.radiance", size: 30, url: "/assets/environment.hdr", contentHash: "hdr" }],
};

describe("project appearance resources", () => {
  it("maps an imported PBR set to the serializable scene material contract", () => {
    expect(materialPatchFromProjectAsset(material)).toMatchObject({
      baseColorMapUrl: "/assets/base.jpg", normalMapUrl: "/assets/normal.jpg", roughnessMapUrl: "/assets/rough.jpg", roughness: 1, metalness: 0,
    });
  });

  it("maps an imported HDRI to the existing scene environment contract", () => {
    expect(environmentPatchFromProjectAsset(DEFAULT_ENVIRONMENT, environment)).toMatchObject({ environmentMapUrl: "/assets/environment.hdr", environmentMapName: "车间晨光" });
  });

  it("renders compact project pickers instead of inert import actions", () => {
    const html = renderToStaticMarkup(<><ProjectMaterialResourcePicker locale="zh-CN" assets={[material]} value={{}} onApply={vi.fn()} /><ProjectEnvironmentResourcePicker locale="zh-CN" assets={[environment]} value={DEFAULT_ENVIRONMENT} onApply={vi.fn()} /></>);
    expect(html).toContain("项目 PBR 材质");
    expect(html).toContain("项目环境");
    expect(html).toContain("工业钢板");
    expect(html).toContain("车间晨光");
  });
});
