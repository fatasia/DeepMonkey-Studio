import type { ModelRecord } from "./project.js";
import type { ProjectAssetRecord } from "./project.js";

export type AssetLibraryDimension = "2d" | "3d" | "environment" | "material" | "effect" | "media";
export type AssetLibraryQualityTier = "light" | "standard" | "heavy";
export type AssetLibraryPublicationStatus = "published" | "review-required" | "deprecated";

export interface AssetLibraryCategoryCount {
  id: string;
  name: string;
  count: number;
}

/** 统一素材目录只暴露平台自己的中性元数据，不把外部站点信息带入产品界面。 */
export interface AssetLibraryItem {
  id: string;
  name: string;
  dimension: AssetLibraryDimension;
  category: string;
  subcategory?: string;
  style?: string;
  format: "glb" | "hdr" | "exr" | "pbr";
  size: number;
  triangleCount: number;
  meshCount: number;
  materialCount: number;
  textureCount: number;
  animated: boolean;
  featured: boolean;
  qualityTier: AssetLibraryQualityTier;
  thumbnailUrl: string;
  previewUrl: string;
  tags: string[];
  version: string;
  license: string;
  publicationStatus: AssetLibraryPublicationStatus;
  contentHash: string;
  mapKinds?: string[];
}

export interface AssetLibraryPage {
  items: AssetLibraryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  categories: AssetLibraryCategoryCount[];
  dimensions: AssetLibraryCategoryCount[];
}

export type AssetLibraryImportResult =
  | { kind: "model"; model: ModelRecord; reused: boolean }
  | { kind: "resource"; asset: ProjectAssetRecord; reused: boolean };
