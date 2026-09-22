import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeferredNumberInput, TransformFields } from "./AppFormControls";

describe("inspector numeric controls", () => {
  it("shows mixed values as an empty draft rather than a fabricated zero", () => {
    const html = renderToStaticMarkup(<DeferredNumberInput value={undefined} placeholder="混合" onCommit={vi.fn()} />);
    expect(html).toContain('placeholder="混合"');
    expect(html).toContain('value=""');
    expect(html).not.toContain("undefined");
  });
  it("gives repeated axes a contextual name and explicit unit", () => {
    const html = renderToStaticMarkup(
      <TransformFields title="位置" suffix="m" transform={{ x: 1.125, y: -2.375, z: 0 }} onChange={vi.fn()} />,
    );
    for (const axis of ["X", "Y", "Z"]) expect(html).toContain(`aria-label="位置 ${axis} (m)"`);
    expect(html).toContain('value="-2.375"');
    expect(html.match(/inputMode="decimal"/g)).toHaveLength(3);
  });

  it("keeps locked transforms disabled and does not invent units for scale", () => {
    const html = renderToStaticMarkup(
      <TransformFields title="缩放" disabled transform={{ x: 1, y: 1, z: 1 }} onChange={vi.fn()} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('aria-label="缩放 X"');
    expect(html).not.toContain("undefined");
  });

  it("preserves draft-friendly decimal entry and explicit numeric limits", () => {
    const html = renderToStaticMarkup(
      <DeferredNumberInput ariaLabel="透明度" value={0.25} min={0} max={1} step={0.01} onCommit={vi.fn()} />,
    );
    expect(html).toContain('type="text"');
    expect(html).toContain('data-min="0"');
    expect(html).toContain('data-max="1"');
    expect(html).toContain('data-step="0.01"');
    expect(html).toContain('value="0.25"');
  });
});
