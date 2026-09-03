import { evaluateWhatIfOperatingEnvelope, type WhatIfStudyRecord } from "@bim-studio/studio-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WhatIfOperatingEnvelopePanel } from "./WhatIfOperatingEnvelopePanel";
import { DEFAULT_WHAT_IF_DRAFT, whatIfRequestFromDraft } from "./whatIfStudy";

function study(overrides: Partial<WhatIfStudyRecord> = {}): WhatIfStudyRecord {
  const request = whatIfRequestFromDraft(DEFAULT_WHAT_IF_DRAFT);
  const result = evaluateWhatIfOperatingEnvelope(request.input);
  return {
    id: "study-1",
    projectId: "project-1",
    name: request.name,
    createdAt: "2026-08-31T08:00:00.000Z",
    input: request.input,
    result,
    execution: {
      engineId: "deterministic-local-elasticity-envelope",
      engineVersion: "1.0.0",
      inputFingerprint: result.inputFingerprint,
      deterministic: true,
    },
    ...overrides,
  };
}

describe("WhatIfOperatingEnvelopePanel", () => {
  it("starts with a clear persisted run workflow", () => {
    const html = renderToStaticMarkup(
      <WhatIfOperatingEnvelopePanel results={[]} busy={false} onRun={() => undefined} onReproduce={() => undefined} />,
    );
    expect(html).toContain("What-if 工况包络");
    expect(html).toContain("运行并留证");
    expect(html).toContain("运行第一个工况");
    expect(html).toContain("不直接控制现场");
  });

  it("renders server evidence, history comparison and exact reproduction", () => {
    const baseline = study();
    const html = renderToStaticMarkup(
      <WhatIfOperatingEnvelopePanel
        results={[study({ id: "study-2", reproductionOf: baseline.id }), baseline]}
        busy={false}
        onRun={() => undefined}
        onReproduce={() => undefined}
      />,
    );
    expect(html).toContain("108");
    expect(html).toContain("复现校验通过");
    expect(html).toContain("精确复现基线");
    expect(html).toContain("不是物理、离散事件或优化求解器结果");
  });
});
