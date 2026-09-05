import type { ModelRecord } from "./project.js";
import type { ProjectAssetRecord } from "./project.js";

export type AssetLibraryDimension = "2d" | "3d" | "environment" | "material" | "effect" | "media";
export type AssetLibraryQualityTier = "light" | "standard" | "heavy";
export type AssetLibraryPublicationStatus = "published" | "review-required" | "deprecated";

/** 再分发所需署名信息；随项目素材与交付保留，不参与品牌清理。 */
export interface AssetAttribution {
  author: string;
  sourceUrl: string;
  licenseUrl: string;
  text: string;
  modifications: string;
}

export interface AssetLibraryCategoryCount {
  id: string;
  name: string;
  count: number;
}

/** 展示元数据保持中性；依法所需的作者、来源与许可必须完整保留。 */
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
  attribution?: AssetAttribution;
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
