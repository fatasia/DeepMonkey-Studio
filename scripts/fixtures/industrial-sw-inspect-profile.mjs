/** Admission for the fixed v16000 framed-container inspection corpus, never geometry readiness. */
export function classifySolidWorksInspect(exitCode, report) {
  if (exitCode !== 0) return { status: 'rejected-by-cli', geometryCertified: false };
  const summary = report?.summary;
  const reasons = [];
  if (report?.command !== 'inspect' || report?.status !== 'ok' || report?.confidence !== 'high') reasons.push('unverified-inspection');
  if (summary?.format !== 'sldprt' || summary?.container_kind !== 'sldprt-blocks') reasons.push('unsupported-container');
  if (summary?.dialects?.primary?.admission !== 'admitted' || summary?.dialects?.primary?.declared?.sw_version !== '16000') reasons.push('unverified-dialect');
  if (!Array.isArray(summary?.entries) || summary.entries.length === 0) reasons.push('no-validated-entries');
  if (!Array.isArray(summary?.notes) || !summary.notes.some(note => /[1-9]\d* CRC-validated block\(s\), [1-9]\d* tail-directory entry\/entries/.test(note))) reasons.push('missing-framed-container-evidence');
  if (summary?.losses?.length) reasons.push('inspection-losses');
  return { status: reasons.length ? 'recovered-inspect-not-qualified' : 'container-inspect-only', reasons, geometryCertified: false };
}
