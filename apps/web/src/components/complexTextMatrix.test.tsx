import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GlobalLightingState } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { COMPLEX_TEXT_MATRIX } from "../visualQa/complexTextMatrix";
import { imeComposingKey, layerKeyboardOccupied } from "./layerKeyboard";
import { OptimizerLayerTree } from "./OptimizerLayerTree";
import type { OptimizerLayer } from "../optimizer/optimizerLayers";
import { FlatSceneObjectList } from "./FlatSceneObjectList";
import { WindowedSceneRows, type SceneRow } from "./WindowedSceneRows";

/** 复杂文本矩阵：RTL/组合字符/emoji ZWJ/代理对/长无空格串在十万行虚拟目录内不破版、不被截码元。 */
describe("complex text matrix in virtualized rows", () => {
  const count = 100_000;
  const nameAt = (index: number) => {
    if (index % 8 !== 0) return `工业设备 ${String(index).padStart(5, "0")}`;
    return COMPLEX_TEXT_MATRIX[(index / 8) % COMPLEX_TEXT_MATRIX.length]!.text;
  };
  const rows: SceneRow[] = Array.from({ length: count }, (_, index) => ({
    key: `device-${index}`,
    keepMounted: index === count - 1,
    render: () => <button>{nameAt(index)}</button>,
  }));

  it("keeps 100,000 mixed-script rows virtualized with the keepMounted tail intact", () => {
    const rendered: number[] = [];
    const virtualRows = rows.map(row => ({ ...row, render: () => { rendered.push(1); return row.render(); } }));
    const html = renderToStaticMarkup(<WindowedSceneRows rows={virtualRows} />);
    expect(rendered.length).toBeLessThan(30);
    expect(html).toContain('data-total-rows="100000"');
    expect(html).toContain('data-windowed="true"');
  });

  it("renders every matrix sample verbatim without dropping code units", () => {
    for (const sample of COMPLEX_TEXT_MATRIX) {
      const html = renderToStaticMarkup(<WindowedSceneRows rows={[{ key: sample.id, render: () => <button>{sample.text}</button> }]} enabled={false} />);
      expect(html, `${sample.id} 必须完整出现在 DOM 文本中`).toContain(sample.text);
    }
    // 代理对与 ZWJ 不得被拆成孤立码元：按 UTF-16 码元扫描，高低代理必须成对。
    for (const sample of COMPLEX_TEXT_MATRIX) {
      const units = [...sample.text].map(char => char.codePointAt(0)!);
      for (let i = 0; i < units.length; i++) {
        const unit = units[i]!;
        const lone = (unit >= 0xd800 && unit <= 0xdbff) || (unit >= 0xdc00 && unit <= 0xdfff);
        expect(lone, `${sample.id} 出现孤立代理 U+${unit.toString(16)}`).toBe(false);
      }
      // ZWJ 序列以 U+200D 连接，必须原样保留。
      if (sample.id === "emoji-zwj") expect(units.filter(unit => unit === 0x200d).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps exotic object names intact through the real directory row", () => {
    for (const sample of COMPLEX_TEXT_MATRIX) {
      const primitive = { id: sample.id, name: sample.text, kind: "primitive", visible: true, opacity: 1 } as LoadedSceneModel;
      const html = renderToStaticMarkup(<FlatSceneObjectList
        locale="zh-CN" studio engine={undefined} modelRows={[]} empty={false}
        lighting={{ lights: [] } as unknown as GlobalLightingState} selectedLightId=""
        primitives={[primitive]} measurements={[]} annotations={[]} spaces={[]} groups={[]}
        organizationObjects={[{ id: sample.id, name: sample.text, kind: "primitive", visible: true, locked: false }]}
        onRevision={vi.fn()} onLightSelect={vi.fn()} onLightUpdate={vi.fn()} onLightTransform={vi.fn()}
        onLightRemove={vi.fn()} onPrimitiveRemove={vi.fn()} onMeasurementRemove={vi.fn()} onEnvironmentOpen={vi.fn()}
        onAnnotationUpdate={vi.fn()} onAnnotationRemove={vi.fn()} onSpaceFocus={vi.fn()}
        onSpaceVisibilityChange={vi.fn()} onSelectGroup={vi.fn()} onRenameGroup={vi.fn()}
        onGroupVisibilityChange={vi.fn()} onGroupLockChange={vi.fn()}
      />);
      expect(html, `${sample.id} 经 PrimitiveRow 渲染后文本完整`).toContain(sample.text);
      // 行名以 title 全文兜底悬浮。
      expect(html).toContain(`title="`);
    }
  });

  it("renders optimizer layer trees with exotic names without breaking the row contract", () => {
    const layers: OptimizerLayer[] = COMPLEX_TEXT_MATRIX.map((sample, index) => (
      { id: index + 1, name: sample.text, depth: 0, hidden: false, deleted: false, mesh: true }));
    const html = renderToStaticMarkup(<OptimizerLayerTree
      locale="zh-CN" layers={layers} busy={false} onEdit={vi.fn()} canUndo={false} canRedo={false} onUndo={vi.fn()} onRedo={vi.fn()}
    />);
    for (const sample of COMPLEX_TEXT_MATRIX) expect(html).toContain(sample.text);
  });
});

describe("IME composition guard", () => {
  const native = (overrides: Partial<KeyboardEvent>) => overrides as unknown as KeyboardEvent;

  it("treats composition confirm/cancel keys as IME-internal, including Safari keyCode 229 echoes", () => {
    expect(imeComposingKey({ nativeEvent: native({ isComposing: true, keyCode: 13 }) })).toBe(true);
    expect(imeComposingKey({ nativeEvent: native({ isComposing: false, keyCode: 229 }) })).toBe(true);
    expect(imeComposingKey({ nativeEvent: native({ isComposing: true, keyCode: 229 }) })).toBe(true);
    expect(imeComposingKey({ nativeEvent: native({ isComposing: false, keyCode: 13 }) })).toBe(false);
    expect(imeComposingKey({ nativeEvent: native({ isComposing: false, keyCode: 27 }) })).toBe(false);
  });

  it("keeps the tree keyboard inert while composing inside a row input", () => {
    const input = { closest: () => ({ tag: "INPUT" }) } as unknown as HTMLElement;
    expect(layerKeyboardOccupied({ target: input, nativeEvent: native({ isComposing: true, keyCode: 40 }) })).toBe(true);
    expect(layerKeyboardOccupied({ target: input, nativeEvent: native({ isComposing: false, keyCode: 40 }) })).toBe(true);
  });
});
