# Dashboard 发布能力证据（C4）

本切片把 C3 的 `dashboardPublicationFreeze` 作为唯一作者与资源身份来源，并把 P0-04 的三种 hash 接到实际目标字节和可信窗口验证。入口是 `apps/api/src/dashboardPublicationCapability.ts`。

## 权威输入与三种 hash

`buildDashboardPublicationCapabilityReport` 先后两次调用 C3 的提交复核：发布指针、发布快照 revision、发布文档、每个绑定数据、字体和图片的 revision/字节/hash 任一变化都会拒绝。编译器只能通过服务端拥有的 `AuthoritativeDashboardCompiler` 回调取得冻结拷贝；没有浏览器 capability 参数。

| hash | 精确输入 | 变化效果 |
| --- | --- | --- |
| `sourceSemanticHash` | authority token + C3 freeze manifest hash | 发布 revision、文档、数据、字体或图片闭包变化必变 |
| `compileGraphHash` | source hash + 编译器 ID、版本、规范化配置 hash | 编译配置或编译器变化必变 |
| `targetArtifactHash` | 编译回调返回的实际 `Uint8Array` | 任一目标字节变化必变 |

窗口验证收据必须逐项绑定 authority、freeze manifest、三种 hash、fixture hash、预期设备 fingerprint 和冻结字体 resourceId/hash/faceIndex。验证器报告的 rendered node 才能把有内容输出的对象升为 `supported`；只有编译器称有内容而没有受信窗口覆盖时仍为 `degraded`，未产出内容为 `blocked`。`webview-only` 没有在此切片中被放行。

## 拒绝面

测试覆盖串 revision、串设备、串字体、篡改发布冻结候选、编译期间 author/resource 变化和提交前变化。类型上没有接受任何客户端 `supported`/capability report 的字段；浏览器可显示诊断，但不能生成这份发布证据。实际目标字节由编译回调交给 verifier 后再计算 `targetArtifactHash`，不接受预报 hash。

## 验证

在隔离工作树执行：

```powershell
pnpm --filter @bim-studio/api typecheck
pnpm --filter @bim-studio/api test -- dashboardPublicationFreeze.test.ts dashboardPublicationCapability.test.ts
```

结果：类型检查通过；2 个测试文件、30 项通过。测试中的 `Uint8Array([9,8,7])` 是被实际 hash 并传入 verifier 的目标 artifact，断言其 SHA-256 与报告一致；它是可复现的最小 artifact，不替代 C5 的正式下载、Native 正常窗口和浏览器截图证据。

## 尚未完成

该模块尚未注册 API route，也未接到 C5 的正式 Dashboard 下载服务。生产接线必须把 `AuthoritativeDashboardCompiler` 和 `verifyWindow` 绑定到现有 Native candidate/window verifier，且把生成的 report 写入正式 manifest；不得用本模块的纯函数测试宣称完成离线发布或视觉验收。
