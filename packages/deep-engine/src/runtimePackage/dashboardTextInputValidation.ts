import { array, fields, integer, record, requireValue, string } from "./primitives.js";
import { decodedLength } from "./deep2d.js";
import { sha256Bytes } from "../shaderPackage/hash.js";
import type { DashboardRuntimePageV1 } from "./dashboardCompositionTypes.js";

export function validateDashboardTextInput(value: unknown, pages: readonly DashboardRuntimePageV1[], payloads: Readonly<Record<string, unknown>>, path: string) {
  const input = record(value, path);
  fields(input, ["kind", "nodeId", "key", "locale", "match", "maxGraphemes", "fonts", "style", "bindings"], [], path);
  requireValue(input.kind === "text-v1" && input.maxGraphemes === 256 && ["zh-CN", "en-US"].includes(String(input.locale)) && ["contains", "exact"].includes(String(input.match)), path, "Unsupported text input profile.");
  const nodes = pages.flatMap(page => page.nodes), node = nodes.find(item => item.id === input.nodeId);
  requireValue(node?.visible && node.hitId === node.id && node.deep2d && !node.chart && node.frame[2] >= 96 && node.frame[2] <= 2048 && node.frame[3] >= 66, path, "Input requires a visible static node with sufficient layout.");
  const key = string(input.key, path); requireValue(key.length > 0 && key.length <= 256 && !/[\u0000-\u001f]/u.test(key), path, "Invalid input key.");
  const fonts = array(input.fonts, path, 8); requireValue(fonts.length > 0, path, "Input requires frozen fonts.");
  let bytes = 0; const seen = new Set<string>();
  for (const value of fonts) {
    const font = record(value, path); fields(font, ["sha256", "faceIndex", "dataBase64"], [], path);
    integer(font.faceIndex, 0, 65535, path); bytes += decodedLength(font.dataBase64, path);
    requireValue(bytes <= 32 * 1024 * 1024, path, "Input fonts exceed 32 MiB.");
    const data = Uint8Array.from(atob(string(font.dataBase64, path)), character => character.charCodeAt(0));
    requireValue(sha256Bytes(data) === font.sha256 && !seen.has(`${font.sha256}:${font.faceIndex}`), path, "Invalid or duplicate input font identity.");
    seen.add(`${font.sha256}:${font.faceIndex}`);
  }
  const style = record(input.style, path); fields(style, ["fontSize", "lineHeight", "fontWeight", "fontStyle", "color"], [], path);
  requireValue(typeof style.fontSize === "number" && style.fontSize >= 1 && style.fontSize <= 32 && typeof style.lineHeight === "number" && style.lineHeight >= style.fontSize && style.lineHeight <= 32, path, "Input text size is unsupported.");
  integer(style.fontWeight, 1, 1000, path); requireValue(["normal", "italic", "oblique"].includes(String(style.fontStyle)), path, "Input font style unsupported.");
  const color = array(style.color, path, 4); requireValue(color.length === 4, path, "Input color requires RGBA."); color.forEach(channel => integer(channel, 0, 255, path));
  const bindings = array(input.bindings, path, 32), targets = new Set<string>(); requireValue(bindings.length > 0, path, "Input requires a frozen binding.");
  requireValue(new TextEncoder().encode(JSON.stringify(bindings)).length <= 4 * 1024 * 1024, path, "Input bindings exceed 4 MiB.");
  for (const value of bindings) {
    const binding = record(value, path); fields(binding, ["nodeId", "datasetId", "rows"], [], path);
    const target = nodes.find(node => node.id === binding.nodeId);
    requireValue(target?.chart && !target.chartSim && !targets.has(target.id), path, "Invalid input target."); targets.add(target.id);
    const chart = (payloads[target.chart] as { chart: { datasets: Array<{ id: string; rows: unknown }> } }).chart;
    requireValue(chart.datasets.length === 1 && chart.datasets[0]!.id === binding.datasetId && JSON.stringify(chart.datasets[0]!.rows) === JSON.stringify(binding.rows), path, "Input binding must freeze the exact target dataset.");
    const rows = array(binding.rows, path, 10000);
    requireValue(rows.every(row => Array.isArray(row) && typeof row[0] === "string" && Array.from(row[0] as string).every(c => /[\x00-\x7f]/u.test(c) || c.toLowerCase() === c.toUpperCase())), path, "Input category casing requires ASCII or uncased script.");
  }
}
