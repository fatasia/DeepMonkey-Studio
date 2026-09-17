# X_T 源身份集合核验

新增独立源身份核验，检查 GLB 中每个 BODY/FACE handle 是否来自输入文件、归属是否一致、源面是否遗漏。109 个真实样本全部通过；这不证明同一 body 内每个三角形的面标签正确。

`scripts/fixtures/xt-source-identity-audit.rs` 直接读取原始实体，按 `FACE.shell → SHELL.region → REGION.body` 建立归属，核对 front-shell 属于同一 body、SHELL 非空 body 与 REGION body 一致。它不调用 cad-xt lowering 或 tessellator。重复/零 handle、悬空或错误类型引用、不支持的字段布局、无面的 body、未读完实体流均拒绝。

本轮布局限于 FACE 14 字段、SHELL 9 字段、REGION 7 字段或末尾附加空 pointer 的 8 字段。该限定覆盖本批固定语料；其他布局不得按这些索引猜测。

每行 JSON 格式：

```json
{"schemaVersion":1,"source":"绝对源路径","sourceBytes":1234,"bodies":[{"body":"7","faces":["42","99"]}]}
```

工具从文件或目录读取并输出 JSONL。使用现有 release `xt_parser` 和 `serde_json` rlib 独立编译，不重建 cad-cli。输出与可执行文件位于 `test-output/xt-causal-baseline/source-identities.jsonl`、`source-identity.exe`。调用方必须在生成报告时绑定实际源 SHA-256、核对 native evidence 的源哈希；`sourceBytes` 不是内容完整性摘要。

`scripts/lib/xtSourceIdentityAudit.mjs` 导出 `auditXtSourceIdentity(glbJson, rawRow)`，返回 `{bodies, uniqueFaces}`。它逐个检查 GLB 标记的归属及精确源集合，允许同一面跨材质/primitive 分块，拒绝伪造 ID、错 body、遗漏 ID 和重复原始证据。它专注身份集合，调用方仍须独立执行 GLB 几何结构、三角区间覆盖和产物哈希审计。

验证结果：

- Rust 2 项测试通过，包括原始归属正例、悬空/错误类型/冲突归属/重复 handle。
- Node 4 项测试通过，包括相同计数下替换 ID、跨 body 换标签、遗漏与分块；另明确测试同一 body 内两面标签互换无法用集合判断。
- `xt-native-mapped/evidence.json` 的 109 个 GLB 全部与原始身份集合一致；逐文件重新读取源和 GLB，SHA-256 分别与 `sourceSha256`、`outputSha256` 一致，源字节数亦一致。
- raw 审计运行前后分别对 109 个源文件取 SHA-256，全部一致；源前后摘要、报告 hash、独立程序 hash 和审计源码 hash 绑定在 `test-output/xt-causal-baseline/source-identities-evidence.json`。主入口 `audit-xt-glb-source-identities.mjs` 已实际运行通过，结果为同目录 `glb-source-identities.json`。

后续仍需用可辨别几何的独立面参考或逐面几何摘要，验证三角形与面标签的对应关系。同一 body 内两个有效 FACE 标签互换会保持集合、数量和归属不变，本核验不宣称识别这种错误。

主线程复跑入口：

```powershell
node scripts/audit-xt-glb-source-identities.mjs test-output/xt-causal-baseline/source-identities.jsonl test-output/xt-native-mapped/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-glb-source-identities.json
node --test scripts/audit-xt-glb-source-identities.test.mjs scripts/lib/xtSourceIdentityAudit.test.mjs
```

入口另有 3 项回归：一一绑定、空/重复证据、源与产物变更、相同数量的身份替换。入口消费已通过几何审计的原转换证据并重新核对产物哈希；它自身不重复进行几何解码或精度认证。
