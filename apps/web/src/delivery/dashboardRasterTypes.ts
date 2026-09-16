import type { DashboardFrozenData } from "./dashboardDataRasterTypes";
import type { DashboardDocument } from "@bim-studio/contracts";

export interface FrozenRasterAsset {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mime: string;
  readonly identity: { readonly id: string; readonly revision: number };
  readonly faceIndex?: number;
}
export interface DashboardRasterTextStyle {
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly fontStyle: "normal" | "italic" | "oblique";
  readonly lineHeight: number;
  readonly color: readonly [number, number, number, number];
  readonly align: "left" | "center" | "right";
}
export interface DashboardRasterNodeAssets {
  readonly fonts?: readonly string[];
  readonly image?: string;
  /** Computed inherited Web styles, frozen by the host; authored values take precedence. */
  readonly textStyle?: DashboardRasterTextStyle;
}
export interface DashboardRasterCompileInput {
  readonly document: DashboardDocument;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly locale: string;
  readonly data?: Readonly<Record<string, DashboardFrozenData | Pick<DashboardFrozenData, "source" | "metric">>>;
  readonly assets: Readonly<Record<string, FrozenRasterAsset>>;
  readonly nodeAssets: Readonly<Record<string, DashboardRasterNodeAssets>>;
}
export interface DashboardTextRasterRequest extends DashboardRasterTextStyle {
  readonly requestHash: string;
  readonly text: string;
  readonly locale: string;
  readonly width: number;
  readonly height: number;
  readonly verticalAlign: "top" | "center" | "bottom";
  readonly wrap: "none" | "word" | "glyph" | "word-or-glyph";
  readonly fonts: readonly FrozenRasterAsset[];
}
export interface DashboardImageRasterRequest {
  readonly requestHash: string;
  readonly width: number;
  readonly height: number;
  readonly fit: "cover" | "contain" | "fill";
  readonly asset: FrozenRasterAsset;
}
export interface DashboardRasterUsedFace {
  readonly sha256: string;
  readonly faceIndex: number;
  readonly family: string;
  readonly postScriptName: string;
  readonly weight: number;
  readonly style: "normal" | "italic" | "oblique";
}
export interface DashboardRasterResult {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly sha256: string;
  readonly requestHash: string;
  /** SHA-256 of the exact producer wire request; supplied by the trusted adapter. */
  readonly sourceSha256: string;
  readonly producer: { readonly id: string; readonly version: string };
  readonly format: "rgba8unorm-srgb";
  readonly alphaMode: "straight";
  readonly producerEvidence?: { readonly scope: "native-text-raster"; readonly sourceSha256: string;
    readonly executableSha256: string; readonly pixelSha256: string; readonly producer: string };
  readonly usedFaces?: readonly DashboardRasterUsedFace[];
  readonly lines?: readonly { readonly lineIndex: number; readonly baseline: number;
    readonly top: number; readonly height: number; readonly width: number }[];
  readonly clipped?: boolean;
}
export interface DashboardRasterHost {
  rasterizeText(request: DashboardTextRasterRequest): Promise<DashboardRasterResult>;
  decodeImage(request: DashboardImageRasterRequest): Promise<DashboardRasterResult>;
}
export interface DashboardRasterEvidence {
  readonly nodeId: string;
  readonly requestHash: string;
  readonly sourceSha256: string;
  readonly pixelSha256: string;
  readonly producer: DashboardRasterResult["producer"];
  readonly producerEvidence?: DashboardRasterResult["producerEvidence"];
  readonly usedFaces: readonly DashboardRasterUsedFace[];
  readonly lines: NonNullable<DashboardRasterResult["lines"]>;
  readonly clipped: boolean;
}
