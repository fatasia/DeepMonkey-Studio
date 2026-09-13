import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import type { ReactElement } from "react";

const harness = vi.hoisted(() => ({ setters: [] as Array<ReturnType<typeof vi.fn>>, copy: vi.fn() }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (value: unknown) => {
    const setter = vi.fn();
    harness.setters.push(setter);
    return [value, setter];
  },
}));
vi.mock("../adapters/runtimeHost", () => ({ runtimeHost: { getServerProfile: () => ({ baseUrl: "https://studio.example.test" }) } }));
vi.mock("./DocsCenterClipboard", () => ({ copyDocumentationCode: harness.copy }));
import { ResourceLinkButton } from "./ResourceLinkButton";

beforeEach(() => { harness.setters = []; harness.copy.mockReset().mockResolvedValue(undefined); });

async function clickCopy(resource: ModelRecord) {
  const rendered = ResourceLinkButton({ locale: "zh-CN", name: "安装板", resource });
  const button = (rendered.props.children as ReactElement<{ onClick: () => void }>[])[0]!;
  button.props.onClick();
  await Promise.resolve();
}

describe("resource copy feedback", () => {
  it("copies the deployed file URL and confirms completion", async () => {
    await clickCopy({ sourceUrl: "/assets/part.glb" } as ModelRecord);
    expect(harness.copy).toHaveBeenCalledWith("https://studio.example.test/assets/part.glb");
    expect(harness.setters[0]).toHaveBeenLastCalledWith(true);
  });
  it("retains a selectable URL when clipboard permission is denied", async () => {
    harness.copy.mockRejectedValueOnce(new Error("NotAllowedError"));
    await clickCopy({ sourceUrl: "/assets/part.glb" } as ModelRecord);
    expect(harness.setters[1]).toHaveBeenLastCalledWith("https://studio.example.test/assets/part.glb");
    expect(harness.setters[2]).toHaveBeenLastCalledWith("复制失败，请手动复制链接");
    expect(harness.setters[0]).not.toHaveBeenCalledWith(true);
  });
  it("does not claim success or copy a temporary preview", async () => {
    await clickCopy({ sourceUrl: "blob:https://studio.example.test/temporary" } as ModelRecord);
    expect(harness.copy).not.toHaveBeenCalled();
    expect(harness.setters[2]).toHaveBeenLastCalledWith("资源尚无可复制的文件地址");
  });
});
