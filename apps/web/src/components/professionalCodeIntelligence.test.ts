import type * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiDocumentationAt, contextualSuggestions, docsMarkdown, isWorkerBehaviorModel, stringLiteralAt } from "./professionalCodeIntelligence";

afterEach(() => vi.unstubAllEnvs());

const api = {
  Range: class {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number
    ) {}
  },
  languages: {
    CompletionItemKind: { Value: 1, Event: 2, Class: 3, Interface: 4, Reference: 5, Module: 6 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 }
  }
} as unknown as typeof monaco;

describe("professional code intelligence", () => {
  it("keeps hover and completion documentation within the hosted editor base", () => {
    vi.stubEnv("BASE_URL", "/DeepMonkey-Studio/");
    expect(apiDocumentationAt(modelFor("studio.camera.setMode('orbit');"), { lineNumber: 1, column: 8 } as monaco.Position)?.href)
      .toBe("/DeepMonkey-Studio/docs/studio-api");
    expect(docsMarkdown("场景对象", "Scene object", "/docs/behavior-script").value)
      .toContain("[打开关联文档](/DeepMonkey-Studio/docs/behavior-script)");
  });
  it("根据调用位置只推荐匹配的稳定对象 ID", () => {
    const model = modelFor('studio.object("pump');
    const suggestions = contextualSuggestions(api, model, { lineNumber: 1, column: 20 } as monaco.Position, {
      targets: [
        { id: "pump-01", name: "循环泵", kind: "object", context: "泵房" },
        { id: "metric-01", name: "温度指标", kind: "component", context: "总览" }
      ],
      references: [],
      dataKeys: [],
      eventNames: []
    }, false);

    expect(suggestions.map((item) => item.label)).toEqual(["pump-01"]);
    expect(suggestions[0]?.detail).toContain("循环泵");
  });

  it("解析字符串范围并提供内置 API 文档", () => {
    const literal = stringLiteralAt(modelFor('studio.setData("device.temperature", 42);'), { lineNumber: 1, column: 24 } as monaco.Position);
    const docs = apiDocumentationAt(modelFor("studio.camera.setMode('orbit');"), { lineNumber: 1, column: 8 } as monaco.Position);

    expect(literal?.value).toBe("device.temperature");
    expect(docs?.title).toBe("studio.camera");
    expect(docs?.href).toBe("/docs/studio-api");
  });

  it("通过 URI 区分受限 Worker 行为脚本", () => {
    expect(isWorkerBehaviorModel(modelFor("", "bim-studio://behavior/pump"))).toBe(true);
    expect(isWorkerBehaviorModel(modelFor("", "bim-studio://script/pump"))).toBe(false);
  });
});

function modelFor(line: string, uri = "bim-studio://script/test"): monaco.editor.ITextModel {
  return {
    getLineContent: () => line,
    uri: { toString: () => uri }
  } as unknown as monaco.editor.ITextModel;
}
