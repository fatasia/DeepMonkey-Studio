import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createInteractionScript } from "../interactionState";
import { InteractionEditor } from "./InteractionEditor";

vi.mock("./ProfessionalCodeEditor", () => ({ ProfessionalCodeEditor: () => <div data-editor="editable" /> }));

describe("locked interaction inspection", () => {
  const target = { kind: "object" as const, modelId: "locked-model" };
  const script = { ...createInteractionScript(target, "click"), code: "api.log('existing script');" };
  it("keeps existing scripts inspectable while disabling mutation and execution controls", () => {
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="锁定模型"
      interactions={[script]} disabled onChange={vi.fn()} onTest={vi.fn()} />);
    expect(html).toContain('<fieldset class="interaction-code-editor" disabled=""');
    expect(html).toContain('aria-label="只读事件脚本"');
    expect(html).toContain("existing script");
    expect(html).not.toContain('data-editor="editable"');
    expect(html).toContain('<button disabled=""');
  });
  it("retains the editable code editor for unlocked objects", () => {
    const html = renderToStaticMarkup(<InteractionEditor locale="zh-CN" target={target} targetName="模型"
      interactions={[script]} onChange={vi.fn()} onTest={vi.fn()} />);
    expect(html).toContain('data-editor="editable"');
    expect(html).not.toContain('<fieldset class="interaction-code-editor" disabled');
  });
});
