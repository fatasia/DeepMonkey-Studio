import { Activity, Box, Database, Focus, Layers3, LayoutDashboard, ScanSearch, Sparkles } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
export function assistantModeTabs(locale: AppLocale, surface: "studio" | "platform", selected: boolean, onApplyDashboard: boolean) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
    if (surface === "studio") {
      return [
        { id: "scene" as const, label: t("场景", "Scene"), icon: Box },
        ...(selected ? [{ id: "component" as const, label: t("对象", "Object"), icon: Focus }] : []),
        { id: "bim" as const, label: "BIM", icon: Layers3 },
        { id: "operations" as const, label: t("仿真运营", "Simulation"), icon: Activity },
        ...(onApplyDashboard ? [{ id: "dashboard" as const, label: t("看板", "Dashboard"), icon: LayoutDashboard }] : []),
        { id: "sql" as const, label: t("问数据", "Ask Data"), icon: Database },
      ];
    }
    return [
      { id: "platform" as const, label: t("全平台", "Platform"), icon: Sparkles },
      { id: "operations" as const, label: t("运营", "Operations"), icon: Activity },
      { id: "vision" as const, label: t("视觉", "Vision"), icon: ScanSearch },
      { id: "bim" as const, label: "BIM", icon: Box },
      { id: "sql" as const, label: t("问数据", "Ask Data"), icon: Database },
    ];
}
