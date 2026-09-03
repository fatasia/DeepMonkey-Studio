import { ChevronDown, PackagePlus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PlantLiteModel } from "@bim-studio/contracts";
import {
  applyPlantLiteProductMix,
  disablePlantLiteProductMix,
  type PlantLiteProductMixInput,
} from "./plantLiteMixEditing";

interface MixDraftRow {
  id?: string;
  name: string;
  percentage: string;
}

export function PlantLiteProductMixEditor({ model, onChange }: {
  model: PlantLiteModel;
  onChange: (model: PlantLiteModel) => void;
}) {
  const modelKey = useMemo(() => JSON.stringify(model.productTypes ?? []), [model.productTypes]);
  const [rows, setRows] = useState<MixDraftRow[]>(() => rowsFromModel(model));
  const [error, setError] = useState("");
  useEffect(() => {
    setRows(rowsFromModel(model));
    setError("");
  }, [modelKey]);
  const configured = Boolean(model.productTypes?.length);
  const total = rows.reduce((sum, row) => sum + (Number(row.percentage) || 0), 0);

  const update = (index: number, patch: Partial<MixDraftRow>) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
    setError("");
  };
  const apply = () => {
    try {
      const input: PlantLiteProductMixInput[] = rows.map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        name: row.name,
        percentage: Number(row.percentage),
      }));
      onChange(applyPlantLiteProductMix(model, input));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "产品组合无效");
    }
  };

  return <details className="plant-product-mix">
    <summary>
      <span><PackagePlus size={14} /><b>产品组合与混流</b><small>{configured ? `${model.productTypes?.length} 种产品` : "未配置 · 单一未分类物料"}</small></span>
      <ChevronDown size={13} />
    </summary>
    <div className="plant-product-mix-body">
      <header>
        <p>显式填写计划投放比例；固定 seed 会复现相同的混流序列。系统不会代填产品或比例。</p>
        <span>当前合计 <b className={Math.abs(total - 100) <= 1e-6 ? "is-valid" : ""}>{formatPercent(total)}%</b></span>
      </header>
      <div className="plant-product-mix-rows" role="table" aria-label="产品混流比例">
        {rows.map((row, index) => <div className="plant-product-mix-row" role="row" key={row.id ?? `new-${index}`}>
          <span>{index + 1}</span>
          <label><small>产品名称</small><input value={row.name} maxLength={120} placeholder="输入产品名称" onChange={(event) => update(index, { name: event.target.value })} /></label>
          <label><small>投放比例</small><span className="plant-percent-input"><input type="number" min={0.01} max={100} step={0.01} value={row.percentage} placeholder="0" onChange={(event) => update(index, { percentage: event.target.value })} /><i>%</i></span></label>
          <button type="button" title="删除产品类型" aria-label={`删除第 ${index + 1} 个产品类型`} onClick={() => { setRows((current) => current.filter((_, rowIndex) => rowIndex !== index)); setError(""); }}><Trash2 size={13} /></button>
        </div>)}
        {!rows.length && <p className="plant-product-mix-empty">添加至少两个产品类型后填写比例，合计必须为 100%。</p>}
      </div>
      {error && <p className="plant-product-mix-error" role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={() => setRows((current) => [...current, { name: "", percentage: "" }])} disabled={rows.length >= 12}><PackagePlus size={13} />添加产品类型</button>
        <span />
        {configured && <button type="button" className="is-muted" onClick={() => onChange(disablePlantLiteProductMix(model))}>关闭混流</button>}
        <button type="button" className="is-primary" onClick={apply}>应用产品组合</button>
      </footer>
    </div>
  </details>;
}

function rowsFromModel(model: PlantLiteModel): MixDraftRow[] {
  return (model.productTypes ?? []).map((productType) => ({
    id: productType.id,
    name: productType.name,
    percentage: formatPercent(productType.share * 100),
  }));
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
