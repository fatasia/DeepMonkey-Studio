import assert from "node:assert/strict";
import { test } from "node:test";
import { scanNativeUiSources } from "./collectNativeUiInventory.mjs";

const fixture = [
  {
    file: "apps/web/src/App.tsx",
    code: `
      import { useEffect } from "react";
      import { init, type EChartsCoreOption } from "echarts/core";
      import Editor from "@monaco-editor/react";
      import * as THREE from "three";
      const option: EChartsCoreOption = { xAxis: {}, yAxis: {}, series: [] };
      export function App() {
        useEffect(() => { document.title = "demo"; void fetch("/api/data"); }, []);
        const worker = new Worker(new URL("./model.worker.ts", import.meta.url));
        const canvas = document.createElement("canvas");
        canvas.getContext("webgpu");
        init(canvas).setOption(option);
        return <Editor />;
      }
    `,
  },
  { file: "apps/web/src/model.worker.ts", code: "self.postMessage({ ready: true });" },
  { file: "apps/web/src/styles/base.css", code: ":root { color: black; }" },
];

test("separates native UI migration coupling categories", () => {
  const result = scanNativeUiSources(fixture);
  for (const category of ["reactLogic", "domCssBrowser", "echarts", "monaco", "worker", "network", "threeRawEscape"]) {
    assert.ok(result.categories[category].fileCount > 0, `${category} should have file evidence`);
    assert.ok(result.categories[category].matchCount > 0, `${category} should have match evidence`);
  }
  assert.equal(result.categories.network.kindCounts["api:fetch"], 1);
  assert.equal(result.categories.worker.kindCounts["worker-entry-file"], 1);
  assert.equal(result.categories.threeRawEscape.kindCounts["raw-context:webgpu"], 1);
  assert.equal(result.categories.domCssBrowser.kindCounts.stylesheet, 1);
  assert.equal(result.parseDiagnostics.length, 0);
});

test("is deterministic and does not treat comments or strings as API calls", () => {
  const sources = [{ file: "case.ts", code: `
    // fetch('/comment'); new Worker('ignored.js'); document.body;
    const text = "navigator.gpu and monaco and THREE.Mesh";
    export const value = text.length;
  ` }];
  const first = scanNativeUiSources(sources);
  assert.deepEqual(first, scanNativeUiSources([...sources].reverse()));
  assert.equal(first.fileEvidence.length, 0);
});

test("does not count project-domain names that shadow browser globals", () => {
  const result = scanNativeUiSources([{ file: "domain.ts", code: `
    export function transform(document: { id: string }, fetch: (id: string) => string) {
      return fetch(document.id);
    }
  ` }]);
  assert.equal(result.categories.domCssBrowser.matchCount, 0);
  assert.equal(result.categories.network.matchCount, 0);
});

test("reports syntax diagnostics without preventing other evidence", () => {
  const result = scanNativeUiSources([{ file: "broken.tsx", code: "import React from 'react'; const x = ; return <div />;" }]);
  assert.ok(result.parseDiagnostics.length > 0);
  assert.ok(result.categories.reactLogic.matchCount > 0);
});
