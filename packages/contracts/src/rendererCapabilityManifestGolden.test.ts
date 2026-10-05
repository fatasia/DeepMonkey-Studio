import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RENDERER_CAPABILITY_MANIFEST, rendererCapabilityManifestJson } from "./rendererCapabilityManifest.js";

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

  it("cross-end row set: TS manifest native column ↔ native self-check rows (bidirectional)", () => {
    // TS↔Rust 一致盘点差距 2 收口补强(2026-10-06):scripts 三方对拍网
    // (scripts/rendererCapabilityManifest.test.mjs)只做 TS→Rust 单向的整文件
    // 正则匹配;本测试在 contracts 侧把 native `renderer_capability_manifest.rs`
    // 的 NATIVE_RENDERER_CAPABILITY_SELF_CHECK 数组**域内解析**成行集,与
    // TS 登记表 native 列做**双向** diff——
    //   ① TS 每行在 native 数组有同 id 同档同行(缺失/漂移即红);
    //   ② native 数组每行在 TS 登记表存在(双清单各自生长即红)。
    // 解析失败(数组找不到/行残缺)直接 fail,不静默放行。
    const rustPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deep-engine-native", "src", "renderer_capability_manifest.rs");
    const rust = readFileSync(rustPath, "utf8");
    const marker = "NATIVE_RENDERER_CAPABILITY_SELF_CHECK: &[NativeCapabilitySelfCheck] = &[";
    const start = rust.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    const arrayStart = start + marker.length;
    const arrayEnd = rust.indexOf("\n];", arrayStart);
    expect(arrayEnd).toBeGreaterThan(arrayStart);
    const body = rust.slice(arrayStart, arrayEnd);

    const rows = new Map<string, { support: string; reason: string }>();
    for (const block of body.split("NativeCapabilitySelfCheck {").slice(1)) {
      const id = /capability_id:\s*"([^"]+)"/.exec(block)?.[1];
      const support = /support:\s*RendererCapabilitySupport::(\w+)/.exec(block)?.[1];
      const reason = /reason:\s*RendererCapabilityReasonCode::(\w+)/.exec(block)?.[1];
      expect(id, "self-check row missing capability_id").toBeTruthy();
      expect(support, `self-check row ${id} missing support`).toBeTruthy();
      expect(reason, `self-check row ${id} missing reason`).toBeTruthy();
      expect(rows.has(id!), `duplicate self-check row ${id}`).toBe(false);
      // Rust PascalCase 变体 → TS kebab-case(逐词镜像,先例 scripts 网同构)。
      rows.set(id!, {
        support: support!.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
        reason: reason!.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
      });
    }

    const manifest = RENDERER_CAPABILITY_MANIFEST as ReadonlyArray<{
      id: string; native: { support: string; reason: string };
    }>;
    // ① TS manifest → native 数组:同 id 行必须存在且支持档/原因码逐词一致。
    for (const entry of manifest) {
      const row = rows.get(entry.id);
      expect(row, `native self-check missing capability ${entry.id}`).toBeTruthy();
      expect(row!.support, `support drift on ${entry.id}`).toBe(entry.native.support);
      expect(row!.reason, `reason drift on ${entry.id}`).toBe(entry.native.reason);
    }
    // ② native 数组 → TS manifest:自检不得声明登记表之外的能力。
    const manifestIds = new Set(manifest.map(e => e.id));
    const extra = [...rows.keys()].filter(id => !manifestIds.has(id));
    expect(extra, `native self-check declares unknown capabilities: ${extra.join(", ")}`).toEqual([]);
  });
});
