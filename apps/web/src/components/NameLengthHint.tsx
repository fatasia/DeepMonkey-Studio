import { translate as tr, type AppLocale } from "../i18n";

/** 显示建议而不截断旧名称；这不是存储合同的硬性长度限制。 */
export function NameLengthHint({ id, value, locale }: { id: string; value: string; locale: AppLocale }) {
  const count = Array.from(value).length;
  const long = count > 60;
  return <small id={id} className={`name-length-hint${long ? " is-long" : ""}`}>
    {long
      ? tr(locale, `已输入 ${count} 字符，建议缩短至 60 字符内，便于在导航和卡片中辨认。完整名称会保留。`, `${count} characters. Consider 60 or fewer for readable navigation and cards. The full name will be preserved.`)
      : tr(locale, `${count} 字符 · 建议不超过 60 字符`, `${count} characters · Recommended: 60 or fewer`)}
  </small>;
}
