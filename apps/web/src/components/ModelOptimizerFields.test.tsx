import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OptionSection } from "./ModelOptimizerFields";

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
