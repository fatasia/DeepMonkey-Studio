/** 页面标题兼容品牌改名前后的拼写，并验证 React 宿主，避免误认同名错误页。 */
export function isStudioWebPage(content: string): boolean {
  return /<title>\s*Deep\s*Monkey\s*Studio\s*<\/title>/i.test(content)
    && /<div\b[^>]*\sid\s*=\s*["']root["'][^>]*>/i.test(content);
}
