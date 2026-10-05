import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rendererCapabilityManifestJson } from "./rendererCapabilityManifest.js";

/**
 * 金样逐字节对拍(TS↔Rust 一致盘点差距 2 修复,2026-10-05):
 * native 端 `renderer_capability_manifest.rs` 以 include_str! 消费
 * fixtures/renderer-capability-manifest.json——若 TS 侧清单漂移而金样未再生成,
 * native 解析的是陈旧数据且现有测试不会打红。本测试把"生成输出 === 金样字节"
 * 钉死:TS 侧任何清单变更必须显式再生成金样(native include_str! 同步刷新)。
 */
const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "renderer-capability-manifest.json");

describe("renderer capability manifest golden parity (TS↔Rust 一致地基)", () => {
  it("regenerated JSON matches the committed golden byte-for-byte", () => {
    const golden = readFileSync(goldenPath, "utf8");
    expect(rendererCapabilityManifestJson()).toBe(golden);
  });

  it("keeps the golden JSON in sync with the native self-check row set", () => {
    // native 自检行(capability_id)与金样 entries 的 id 集合必须一致——
    // 双端各自维护行,集合漂移即对拍破裂(J4/TS-Rust 盘点 §3.3)。
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
      entries: ReadonlyArray<{ id: string }>;
    };
    const manifest = JSON.parse(rendererCapabilityManifestJson()) as {
      entries: ReadonlyArray<{ id: string }>;
    };
    const goldenIds = golden.entries.map(e => e.id).sort();
    const manifestIds = manifest.entries.map(e => e.id).sort();
    expect(manifestIds).toEqual(goldenIds);
  });
});
