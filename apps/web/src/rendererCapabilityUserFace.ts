import { RENDERER_CAPABILITY_MANIFEST, type RendererCapabilityManifestEntry } from "@bim-studio/contracts";
import { translate, type AppLocale } from "./i18n";

/**
 * K17:渲染能力清单的用户面与上下文摘要。
 * 数据单源=contracts 登记表(与 deep-engine 自检/native 同形声明三方对拍由既有测试
 * 强制),本文件只做派生展示面——支持档/原因码/证据路径直达"降级在哪、为什么"。
 */

export interface RendererCapabilityRow {
  readonly id: string;
  readonly title: string;
  readonly support: RendererCapabilityManifestEntry["web"]["support"];
  readonly reason: RendererCapabilityManifestEntry["web"]["reason"];
  readonly evidence: string;
}

const SUPPORT_ORDER = { unavailable: 0, degraded: 1, supported: 2 } as const;

/** 用户面清单:降级/缺席在前(support 升序),其余按登记序。 */
export function rendererCapabilityRows(): readonly RendererCapabilityRow[] {
  return RENDERER_CAPABILITY_MANIFEST
    .map(entry => ({ id: entry.id, title: entry.title, support: entry.web.support, reason: entry.web.reason, evidence: entry.web.evidence }))
    .sort((a, b) => SUPPORT_ORDER[a.support] - SUPPORT_ORDER[b.support]);
}

/** 非 supported 能力行(诊断面板摘要与 AI 上下文共用口径)。 */
export function degradedRendererCapabilities(): readonly RendererCapabilityRow[] {
  return rendererCapabilityRows().filter(row => row.support !== "supported");
}

const SUPPORT_LABELS: Record<RendererCapabilityRow["support"], { zh: string; en: string }> = {
  supported: { zh: "完整", en: "Full" },
  degraded: { zh: "降级", en: "Degraded" },
  unavailable: { zh: "不可用", en: "Unavailable" },
};

export function rendererCapabilityRowLabel(row: RendererCapabilityRow, locale: AppLocale): string {
  const support = translate(locale, SUPPORT_LABELS[row.support].zh, SUPPORT_LABELS[row.support].en);
  return `${row.title} · ${support}`;
}

/** Harness/AI 上下文摘要:一行口径,回答"当前渲染器哪些能力受限"有据可查。 */
export function rendererCapabilityContextSummary(locale: AppLocale): string {
  const degraded = degradedRendererCapabilities();
  if (degraded.length === 0) {
    return translate(locale, "渲染能力清单：全部能力完整支持。", "Renderer capabilities: all declared capabilities are fully supported.");
  }
  const head = translate(locale, "渲染能力清单：", "Renderer capabilities: ");
  const items = degraded.map(row => rendererCapabilityRowLabel(row, locale)).join("; ");
  return `${head}${translate(locale, `${degraded.length} 项受限（`, `${degraded.length} limited (`)}${items}）`;
}
