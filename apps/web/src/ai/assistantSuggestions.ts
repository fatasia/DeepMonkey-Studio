import type { AssistantMode } from "../api";
import { translate as tr, type AppLocale } from "../i18n";

/** 推荐问题只覆盖当前页面能提供证据的任务，不用泛化提示词填满空态。 */
export function assistantSuggestions(mode: AssistantMode, locale: AppLocale): string[] {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  if (mode === "platform") {
    return [
      t("现在平台上有哪些真实可运行的 AI 模型？", "Which AI models can actually run on this platform now?"),
      t("当前最需要处理的风险和缺口是什么？", "Which risks and gaps need attention first?"),
      t("按设备、质量、物流、能耗给我今日行动清单", "Give me today's actions for assets, quality, logistics, and energy"),
    ];
  }
  if (mode === "operations") {
    return [
      t("哪些维护模型能运行，哪些只能影子验证？", "Which maintenance models can run, and which are shadow-only?"),
      t("最近一次设备评估用了什么数据，结论是什么？", "What data and conclusion were used in the latest asset assessment?"),
      t("物流和能耗目前有什么可执行建议？", "What actionable logistics and energy recommendations are available?"),
    ];
  }
  if (mode === "vision") {
    return [
      t("当前有哪些真实视觉模型和运行任务？", "Which real vision models and jobs are currently available?"),
      t("最近有哪些缺陷事件经过人工复核？", "Which recent defect events were reviewed by a person?"),
    ];
  }
  if (mode === "bim") {
    return [
      t("当前模型有哪些楼层、系统和构件类别？", "Which levels, systems, and component categories are in this model?"),
      t("有多少摄像头，分别在哪个楼层和房间？", "How many cameras are there, and which level and room is each in?"),
    ];
  }
  if (mode === "scene") {
    return [
      t("检查当前场景的对象、数据绑定和交互缺口", "Check this scene for object, data-binding, and interaction gaps"),
      t("当前场景有哪些高风险状态需要优先验证？", "Which high-risk states in this scene should be verified first?"),
      t("给出当前场景的仿真与虚拟调试检查清单", "Create a simulation and virtual commissioning checklist for this scene"),
    ];
  }
  if (mode === "component") {
    return [
      t("解释当前选中对象的身份、属性和可用交互", "Explain the selected object's identity, properties, and available interactions"),
      t("检查当前对象的数据绑定、动画与脚本风险", "Check the selected object's data binding, animation, and script risks"),
      t("为当前对象生成可审查的交互脚本建议", "Draft a reviewable interaction script suggestion for the selected object"),
    ];
  }
  if (mode === "dashboard") {
    return [
      t("根据当前数据目录优化这个二维页面", "Improve this 2D page using the current data catalog"),
      t("检查当前选中组件的布局、字段与单位", "Check the selected component's layout, fields, and units"),
    ];
  }
  return [
    t("查询最近 24 小时各设备的平均温度", "Query average temperature by asset for the last 24 hours"),
    t("按设备比较当前数据集的最大能耗", "Compare maximum energy use by asset in the current dataset"),
  ];
}
