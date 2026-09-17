import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compareXtSourceCounts } from './lib/xtSourceCountAudit.mjs';

const [reportPath, evidencePath, outputPath] = process.argv.slice(2);
if (!reportPath || !evidencePath || !outputPath) {
  throw new Error('Usage: audit-xt-source-counts <report.tsv> <native-evidence.json> <output.json>');
}
const [report, evidence] = await Promise.all([readFile(reportPath), readFile(evidencePath)]);
// Windows PowerShell 5 Tee-Object emits UTF-16LE; PowerShell 7 emits UTF-8.
const encoding = report[0] === 0xff && report[1] === 0xfe ? 'utf16le' : 'utf8';
const result = compareXtSourceCounts(report.toString(encoding), JSON.parse(evidence.toString('utf8')));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await writeFile(outputPath, JSON.stringify({ ...result,
  sourceReportSha256: hash(report), conversionEvidenceSha256: hash(evidence) }, null, 2) + '\n');
console.log(JSON.stringify(result.summary));
