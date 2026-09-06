import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocsSdkExamples } from "./DocsSdkExamples";
import { DocsCenter } from "./DocsCenter";

describe("DocsSdkExamples", () => {
  it("keeps all examples readable when not logged in and explains the disabled insertion", () => {
    const html = renderToStaticMarkup(<DocsSdkExamples />);
    for (const title of ["认识脚本生命周期", "读取应用变量", "观察场景点击事件", "Worker · API 1.0", "无需额外权限", "复制代码", "请先登录"]) expect(html).toContain(title);
    expect(html).toMatch(/class="docs-sdk-primary"[^>]*disabled=""/);
    expect(html).not.toContain("确认新增脚本");
  });

  it("exposes the product catalog entry and active insertion with current workspace context", () => {
    const html = renderToStaticMarkup(<DocsCenter systemName="Studio" documentId="sdk-examples" onNavigate={() => undefined} onClose={() => undefined}
      sdkExampleContext={{ authenticated: true, projectId: "p", projectName: "Project", applicationId: "a" }} onInsertSdkExample={() => undefined} />);
    expect(html).toContain("SDK 可运行样例");
    expect(html).toContain('aria-label="可运行样例"');
    expect(html).toContain("在脚本编辑器中新增");
    expect(html).not.toMatch(/class="docs-sdk-primary"[^>]*disabled=""/);
    expect(html).toContain("保存遵循编辑器当前的自动保存设置");
  });
});
