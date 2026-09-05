import { ServerRequestError } from "@bim-studio/server-sdk";
import { translate, type AppLocale } from "../i18n";

/** 登录失败不等于密码错误；网关、限流和断网要给出不同的恢复路径。 */
export function loginErrorMessage(reason: unknown, locale: AppLocale): string {
  const t = (zh: string, en: string) => translate(locale, zh, en);
  if (reason instanceof ServerRequestError) {
    if (reason.status >= 500) return t("登录服务暂时不可用，请稍后重试；无需修改密码。", "The sign-in service is temporarily unavailable. Retry shortly; no password change is needed.");
    if (reason.status === 429) return t("尝试过于频繁，请稍后再登录。", "Too many attempts. Please wait before trying again.");
    if (reason.status === 401) return t("用户名或密码错误", "Incorrect username or password");
  }
  if (reason instanceof TypeError || (reason instanceof Error && /network|fetch|timeout/i.test(reason.message))) {
    return t("无法连接登录服务，请检查网络后重试。", "Cannot reach the sign-in service. Check your connection and retry.");
  }
  return reason instanceof Error ? reason.message : t("登录未完成，请重试。", "Sign-in did not complete. Please retry.");
}
