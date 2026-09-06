/** 网络诊断不把完整资源 URL 当正文；结构/回滚错误仍保持原来的具体语义。 */
export function modelInstanceError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const status = message.match(/^fetch for ".*" responded with (\d{3})(?::|$)/i)?.[1];
  if (status) return `素材下载失败（${status}），请重试。`;
  if (/^(Failed to fetch|NetworkError when attempting to fetch resource\.?)$/i.test(message)) return "素材下载失败，请检查网络后重试。";
  return message;
}
