import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactNode } from "react";
import { SceneEnvironmentMips } from "./SceneEnvironmentMips";
import { DEFAULT_ENVIRONMENT } from "../appDefaults";

describe("author reflection detail control", () => {
  it("shows saved custom levels, legacy full mode and an explained disabled state", () => {
    const props = { locale: "en-US" as const, environment: { ...DEFAULT_ENVIRONMENT, environmentSpecularMips: 3 },
      active: false, onChange: vi.fn() };
    const html = renderToStaticMarkup(<SceneEnvironmentMips {...props} />);
    expect(html).toContain("3 levels"); expect(html).toContain("disabled");
    expect(html).toContain("Switch to Deep WebGPU");
    expect(renderToStaticMarkup(<SceneEnvironmentMips {...props} environment={DEFAULT_ENVIRONMENT} active />))
      .toContain('value="full" selected');
  });
  it("changes only saved mip policy, clears full mode and refuses invalid values", () => {
    const onChange = vi.fn(), props = { locale: "en-US" as const,
      environment: { ...DEFAULT_ENVIRONMENT, environmentIntensity: .7 }, active: true, onChange };
    let callback!: (event: { target: { value: string } }) => void;
    const visit = (node: ReactNode) => Children.forEach(node, child => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "select") callback = child.props.onChange as typeof callback;
      visit(child.props.children as ReactNode);
    });
    visit(SceneEnvironmentMips(props));
    for (const value of ["0", "9", "NaN", "1.5"]) callback({ target: { value } });
    expect(onChange).not.toHaveBeenCalled();
    callback({ target: { value: "4" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...props.environment, environmentSpecularMips: 4 });
    callback({ target: { value: "full" } });
    expect(onChange).toHaveBeenLastCalledWith(props.environment);
  });
});
