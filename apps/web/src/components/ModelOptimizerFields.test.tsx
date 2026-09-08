import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { localizeOptimizerMessage, optimizationSizeMessage, OptionSection } from "./ModelOptimizerFields";

describe("OptionSection", () => {
  it("exposes optimizer toggles as named switches", () => {
    const html = renderToStaticMarkup(
      <OptionSection icon={<span />} title="模型减面" enabled onToggle={vi.fn()}>
        <p>设置</p>
      </OptionSection>
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="模型减面"');
    expect(html).toContain('aria-checked="true"');
  });
});

describe("optimizationSizeMessage", () => {
  it("reports compatibility growth instead of claiming a zero reduction", () => {
    expect(optimizationSizeMessage(100, 112)).toBe("优化完成，体积增加 12%");
    expect(localizeOptimizerMessage("en-US", "优化完成，体积增加 12%")).toBe("Optimization complete; size increased by 12%");
  });

  it("keeps the normal reduction result", () => {
    expect(optimizationSizeMessage(100, 64)).toBe("优化完成，体积减少 36%");
  });
});
