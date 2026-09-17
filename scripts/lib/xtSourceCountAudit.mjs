const normalize = (value) => value.replaceAll('\\', '/');

/** Compare raw entity counts, never treating the converter's own denominator as source truth. */
export function compareXtSourceCounts(report, evidence) {
  const sourceCounts = new Map();
  for (const line of report.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('TOTAL\t')) continue;
    const fields = line.split('\t');
    if (fields.length !== 4) throw new Error('Source audit must include the raw-count column');
    const source = JSON.parse(fields[1]);
    const counts = JSON.parse(fields[3]);
    if (typeof source !== 'string') throw new Error('Invalid source name');
    const key = normalize(source);
    if (sourceCounts.has(key)) throw new Error(`Duplicate source: ${key}`);
    if (counts !== null && !['bodies', 'faces', 'uniqueFaces'].every((field) =>
      Number.isSafeInteger(counts[field]) && counts[field] >= 0)) throw new Error(`Invalid counts: ${key}`);
    sourceCounts.set(key, counts);
  }
  if (!sourceCounts.size || !Array.isArray(evidence?.results) || !evidence.results.length) {
    throw new Error('Both audits must contain samples');
  }
  const seen = new Set();
  const results = evidence.results.map((row) => {
    if (typeof row.source !== 'string') throw new Error('Invalid converter source');
    const source = normalize(row.source);
    if (seen.has(source)) throw new Error(`Duplicate converter source: ${source}`);
    seen.add(source);
    if (!sourceCounts.has(source)) throw new Error(`Missing source audit: ${source}`);
    const raw = sourceCounts.get(source);
    const reported = row.reported;
    const agrees = raw !== null && raw.faces > 0 && raw.bodies > 0
      && raw.uniqueFaces === raw.faces && row.status === 'preview-evidence'
      && row.countsAgree === true && reported?.bodies === raw.bodies
      && reported?.faces === raw.faces && reported?.meshedFaces === raw.faces;
    return { source, raw, reported: reported ?? null, sourceCountsAgree: agrees };
  });
  if (seen.size !== sourceCounts.size) throw new Error('Source audit contains unmatched samples');
  return {
    schemaVersion: 1, scope: 'raw-source-count-comparison-only',
    summary: { total: results.length, sourceCountsAgree: results.filter((row) => row.sourceCountsAgree).length,
      productionProfilesCertified: 0 }, results,
  };
}
