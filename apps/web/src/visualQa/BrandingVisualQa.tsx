import { DEFAULT_PRODUCT_BRANDING } from "@bim-studio/contracts";
import { BrandingSettingsPage } from "../components/BrandingSettingsPage";

/** 使用真实设置页结构与样式的只读视觉验收入口。 */
export default function BrandingVisualQa() {
  return <BrandingSettingsPage
    value={{ ...DEFAULT_PRODUCT_BRANDING }}
    locale="zh-CN"
    onChange={() => undefined}
    onBack={() => undefined}
  />;
}
