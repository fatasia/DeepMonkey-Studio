import { Boxes, Download, FileJson2, Grid3X3, LoaderCircle, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import {
  createDeviceGrid,
  parseDeviceLayoutText,
  toDeviceGeoJson,
  transformDeviceLayout,
  type DeviceBoxDraft,
  type DeviceGridOptions,
  type DeviceLayoutTransform,
} from "../deviceLayout/deviceLayout";

interface DeviceLayoutWorkbenchProps {
  locale: AppLocale;
  onApply: (devices: DeviceBoxDraft[], createLabels: boolean) => Promise<void> | void;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
}

const DEFAULT_GRID: DeviceGridOptions = {
  rows: 3,
  columns: 4,
  spacingX: 4,
  spacingZ: 5,
  originX: 0,
  originY: 0,
  originZ: 0,
  width: 2,
  height: 2.4,
  depth: 1.5,
  prefix: "设备",
  color: "#3f8cff",
};
const DEFAULT_TRANSFORM: DeviceLayoutTransform = { offsetX: 0, offsetY: 0, offsetZ: 0, scale: 1 };
const SAMPLE_TABLE = "设备编号,设备名称,坐标X,坐标Y,坐标Z,宽度,高度,深度,类别\nP-001,循环泵,0,0,0,2,2.4,1.5,泵\nP-002,循环泵,4,0,0,2,2.4,1.5,泵";

export function DeviceLayoutWorkbench(props: DeviceLayoutWorkbenchProps) {
  const [mode, setMode] = useState<"grid" | "import">("grid");
  const [grid, setGrid] = useState(DEFAULT_GRID);
  const [source, setSource] = useState(SAMPLE_TABLE);
  const [transform, setTransform] = useState(DEFAULT_TRANSFORM);
  const [createLabels, setCreateLabels] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>();

  const result = useMemo(() => {
    try {
      const parsed = mode === "grid" ? { devices: createDeviceGrid(grid), issues: [] } : parseDeviceLayoutText(source);
      return { ...parsed, devices: transformDeviceLayout(parsed.devices, transform) };
    } catch (reason) {
      return { devices: [], issues: [reason instanceof Error ? reason.message : String(reason)] };
    }
  }, [grid, mode, source, transform]);

  async function importFile(file: File | undefined) {
    if (!file) return;
    setSource(await file.text());
    setMode("import");
  }

  function downloadGeoJson() {
    const blob = new Blob([`${JSON.stringify(toDeviceGeoJson(result.devices), null, 2)}\n`], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "device-layout.geojson";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function applyDevices() {
    if (applying || result.devices.length === 0) return;
    setApplying(true);
    setApplyError(undefined);
    props.onBusyChange?.(true);
    let completed = false;
    try {
      await props.onApply(result.devices, createLabels);
      completed = true;
    } catch (reason) {
      setApplyError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplying(false);
      props.onBusyChange?.(false);
    }
    if (completed) props.onClose();
  }

  return (
    <section
      className="device-layout-workbench"
      role="dialog"
      aria-modal="true"
      aria-busy={applying}
      aria-label={tr(props.locale, "批量设备布局", "Batch device layout")}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header>
        <span>
          <Boxes size={17} />
          <span>
            <strong>{tr(props.locale, "批量设备布局", "Batch device layout")}</strong>
            <small>{tr(props.locale, "数据/图纸坐标 → GeoJSON → 方盒与标签", "Data/drawing coordinates → GeoJSON → boxes and labels")}</small>
          </span>
        </span>
        <button className="device-layout-close" disabled={applying} onClick={props.onClose} aria-label={tr(props.locale, "关闭设备布局", "Close device layout")}>
          <X size={17} />
        </button>
      </header>

      <fieldset className="device-layout-content" disabled={applying}>
        <div className="device-layout-mode" role="tablist">
          <button role="tab" aria-selected={mode === "grid"} className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")}>
            <Grid3X3 size={13} />
            {tr(props.locale, "规则阵列", "Grid")}
          </button>
          <button role="tab" aria-selected={mode === "import"} className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}>
            <FileJson2 size={13} />
            {tr(props.locale, "导入数据/GeoJSON", "Import data/GeoJSON")}
          </button>
        </div>

        {mode === "grid" ? (
          <GridEditor locale={props.locale} value={grid} onChange={setGrid} />
        ) : (
          <ImportEditor locale={props.locale} value={source} onChange={setSource} onFile={importFile} />
        )}

        <details className="device-layout-alignment">
          <summary>{tr(props.locale, "图纸对齐与坐标换算", "Drawing alignment and coordinates")}</summary>
          <p>
            {tr(
              props.locale,
              "场景 Y 轴向上；GeoJSON 坐标顺序为 [X,Z,Y]。可用比例与偏移对齐已导入的 DXF/平面图。",
              "Scene Y is up; GeoJSON uses [X,Z,Y]. Use scale and offsets to align an imported DXF/floor plan.",
            )}
          </p>
          <div className="device-layout-fields four">
            <NumberField label={tr(props.locale, "比例", "Scale")} value={transform.scale} min={0.0001} onChange={(scale) => setTransform((current) => ({ ...current, scale }))} />
            <NumberField label="Offset X" value={transform.offsetX} onChange={(offsetX) => setTransform((current) => ({ ...current, offsetX }))} />
            <NumberField label="Offset Y" value={transform.offsetY} onChange={(offsetY) => setTransform((current) => ({ ...current, offsetY }))} />
            <NumberField label="Offset Z" value={transform.offsetZ} onChange={(offsetZ) => setTransform((current) => ({ ...current, offsetZ }))} />
          </div>
        </details>

        <div className="device-layout-preview">
          <header>
            <strong>{tr(props.locale, `预览 ${result.devices.length} 台设备`, `Preview ${result.devices.length} devices`)}</strong>
            <span>{tr(props.locale, "前 6 项", "First 6")}</span>
          </header>
          {result.devices.slice(0, 6).map((device) => (
            <div key={device.id}>
              <i style={{ background: device.color }} />
              <span>
                <strong>{device.name}</strong>
                <small>
                  {device.id} · ({format(device.position.x)}, {format(device.position.y)}, {format(device.position.z)}) · {format(device.size.width)}×{format(device.size.height)}×
                  {format(device.size.depth)}
                </small>
              </span>
            </div>
          ))}
          {result.devices.length === 0 && <p>{tr(props.locale, "没有可创建的设备", "No valid devices")}</p>}
        </div>
        {result.issues.length > 0 && (
          <div className="device-layout-issues">
            {result.issues.slice(0, 5).map((issue) => (
              <span key={issue}>{issue}</span>
            ))}
          </div>
        )}
        {applyError && (
          <div className="device-layout-issues" role="alert">
            <span>{applyError}</span>
          </div>
        )}

        <label className="device-layout-label-option">
          <input type="checkbox" checked={createLabels} onChange={(event) => setCreateLabels(event.target.checked)} />
          <span>
            <strong>{tr(props.locale, "同时创建模型标签", "Create model labels")}</strong>
            <small>{tr(props.locale, "标签与方盒使用同一设备 ID，可继续绑定实时数据和告警", "Labels and boxes share the equipment ID for live data and alarms")}</small>
          </span>
        </label>
      </fieldset>
      <footer>
        <button className="button" disabled={applying || result.devices.length === 0} onClick={downloadGeoJson}>
          <Download size={13} />
          {tr(props.locale, "导出 GeoJSON", "Export GeoJSON")}
        </button>
        <button className="button primary" disabled={applying || result.devices.length === 0} onClick={() => void applyDevices()}>
          {applying ? <LoaderCircle className="spin" size={14} /> : <Boxes size={14} />}
          {applying ? tr(props.locale, "正在创建…", "Creating…") : tr(props.locale, `创建 ${result.devices.length} 台设备`, `Create ${result.devices.length} devices`)}
        </button>
      </footer>
    </section>
  );
}

function GridEditor(props: { locale: AppLocale; value: DeviceGridOptions; onChange: (value: DeviceGridOptions) => void }) {
  const update = <K extends keyof DeviceGridOptions>(key: K, value: DeviceGridOptions[K]) => props.onChange({ ...props.value, [key]: value });
  return (
    <div className="device-layout-grid-editor">
      <div className="device-layout-fields two">
        <label>
          <span>{tr(props.locale, "设备前缀", "Device prefix")}</span>
          <input value={props.value.prefix} onChange={(event) => update("prefix", event.target.value)} />
        </label>
        <label>
          <span>{tr(props.locale, "颜色", "Color")}</span>
          <input type="color" value={props.value.color} onChange={(event) => update("color", event.target.value)} />
        </label>
        <NumberField label={tr(props.locale, "行数", "Rows")} value={props.value.rows} min={1} step={1} onChange={(value) => update("rows", value)} />
        <NumberField label={tr(props.locale, "列数", "Columns")} value={props.value.columns} min={1} step={1} onChange={(value) => update("columns", value)} />
        <NumberField label={tr(props.locale, "X 间距", "X spacing")} value={props.value.spacingX} min={0.001} onChange={(value) => update("spacingX", value)} />
        <NumberField label={tr(props.locale, "Z 间距", "Z spacing")} value={props.value.spacingZ} min={0.001} onChange={(value) => update("spacingZ", value)} />
      </div>
      <div className="device-layout-fields three">
        <NumberField label={tr(props.locale, "宽", "Width")} value={props.value.width} min={0.001} onChange={(value) => update("width", value)} />
        <NumberField label={tr(props.locale, "高", "Height")} value={props.value.height} min={0.001} onChange={(value) => update("height", value)} />
        <NumberField label={tr(props.locale, "深", "Depth")} value={props.value.depth} min={0.001} onChange={(value) => update("depth", value)} />
      </div>
    </div>
  );
}

function ImportEditor(props: { locale: AppLocale; value: string; onChange: (value: string) => void; onFile: (file: File | undefined) => void }) {
  return (
    <div className="device-layout-import-editor">
      <label className="device-layout-file">
        <Upload size={13} />
        <span>{tr(props.locale, "选择 CSV / TSV / JSON / GeoJSON", "Choose CSV / TSV / JSON / GeoJSON")}</span>
        <input type="file" accept=".csv,.tsv,.json,.geojson,text/csv,application/json" onChange={(event) => void props.onFile(event.target.files?.[0])} />
      </label>
      <textarea
        value={props.value}
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
        aria-label={tr(props.locale, "设备布局数据", "Device layout data")}
      />
      <small>
        {tr(
          props.locale,
          "自动识别中英文字段：设备编号/名称、X/Y/Z、宽/高/深、类别、颜色。Polygon 按轮廓包围盒生成设备。",
          "Auto-detects ID/name, X/Y/Z, width/height/depth, category and color. Polygons become box footprints.",
        )}
      </small>
    </div>
  );
}

function NumberField(props: { label: string; value: number; min?: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span>{props.label}</span>
      <input type="number" value={props.value} min={props.min} step={props.step ?? 0.1} onChange={(event) => props.onChange(Number(event.target.value))} />
    </label>
  );
}

function format(value: number): string {
  return Number(value.toFixed(2)).toString();
}
