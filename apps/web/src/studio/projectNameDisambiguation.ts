/**
 * F10（2026-10-05 对抗测试）项目下拉重名消歧。
 *
 * 复用场景侧"同名告警"的治理口径（SceneManagerView 同名场景提示），但项目下拉
 * 里的重名项需要**可直接区分**：同名项目并列时以创建日期后缀区分；创建时间缺失
 * 或不可解析时回退项目 ID 尾号。无同名时保持原名，不给普通项目加噪音。
 */

export interface ProjectDisambiguationInput {
  id: string;
  name: string;
  createdAt: string;
}

/** 计算 id → 下拉显示文本；仅同名项目获得消歧后缀。 */
export function disambiguatedProjectLabels(projects: readonly ProjectDisambiguationInput[]): Map<string, string> {
  const nameCounts = new Map<string, number>();
  for (const project of projects) nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const project of projects) {
    const duplicates = nameCounts.get(project.name) ?? 0;
    labels.set(project.id, duplicates <= 1 ? project.name : `${project.name}（${projectDisambiguator(project)}）`);
  }
  return labels;
}

/** 消歧凭据：优先创建日期（本地时区 yyyy-MM-dd）；缺失/不可解析回退 ID 尾号。 */
function projectDisambiguator(project: ProjectDisambiguationInput): string {
  const createdAt = new Date(project.createdAt);
  if (!Number.isNaN(createdAt.getTime())) {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${createdAt.getFullYear()}-${pad(createdAt.getMonth() + 1)}-${pad(createdAt.getDate())}`;
  }
  return `ID ${project.id.slice(-4)}`;
}
