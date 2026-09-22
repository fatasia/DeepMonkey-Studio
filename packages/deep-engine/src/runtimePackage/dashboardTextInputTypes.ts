/** 离线单行文本筛选：字体原始字节允许运行时生成任意受该字体覆盖的字形。 */
export interface DashboardTextInputV1 {
  readonly kind: "text-v1";
  readonly nodeId: string;
  readonly key: string;
  readonly locale: "zh-CN" | "en-US";
  readonly match: "contains" | "exact";
  readonly maxGraphemes: 256;
  readonly fonts: readonly { readonly sha256: string; readonly faceIndex: number; readonly dataBase64: string }[];
  readonly style: { readonly fontSize: number; readonly lineHeight: number; readonly fontWeight: number;
    readonly fontStyle: "normal" | "italic" | "oblique"; readonly color: readonly [number, number, number, number] };
  readonly bindings: readonly { readonly nodeId: string; readonly datasetId: string;
    readonly rows: readonly (readonly (string | number | boolean | null)[])[] }[];
}
