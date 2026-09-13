import type { AskDataQueryReadResult } from "@bim-studio/contracts";

export function QuerySampleResult({ output }: { output: unknown }) {
  const result = (output as { result?: AskDataQueryReadResult } | undefined)?.result;
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return null;
  return <div className="ai-query-sample-table"><table><thead><tr>{result.columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead>
    <tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map(column => <td key={column.key}>{String(row[column.key] ?? "—")}</td>)}</tr>)}</tbody>
  </table></div>;
}
