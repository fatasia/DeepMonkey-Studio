# Battery manifest EOL/hash audit (2026-09-25)

## 现状核查

1. **全仓关键词**：`candidate-manifests.json`、`battery-examples.manifest.json`、`batteryLocalGateway` 和静态样例测试已存在；本轮不新增验证器。
2. **契约层**：`BatteryOnnxEquivalenceManifest` 在 `packages/contracts/src/battery.ts` 已定义尺寸、SHA-256、runtime adapter schema；样例合同在 `apps/web/src/ai/batterySample.ts` 已定义。
3. **依赖**：校验只使用 Node `crypto`/`fs`，无需新增依赖。
4. **消费方**：API `loadBatteryOnnxDeployment` 对 manifest 的大小与 SHA-256 做逐文件校验；Web `batterySample.test.ts` 对静态样例做同样校验。
5. **已有证据**：API `batteryLocalGateway.test.ts`、`industrialCapabilities.test.ts` 与 Web `batterySample.test.ts` 已覆盖发布路径；此前失败表现为 runtime adapter 实际 1471 字节而清单记录 1537，Web 样例 SHA-256 不匹配。
6. **规格/交接**：交接与恢复总账要求电池制品使用可复现清单；失败集中在 Git checkout 将发布 payload 的 CRLF 归一为 LF。

## 根因与修正

清单 SHA-256 和 `sizeBytes` 针对发布字节计算。仓库原有全局 `text eol=lf`，导致工作树检出时六个 CSV 与三个 runtime adapter JSON 被转换为 LF。将这些发布 payload 在 `.gitattributes` 中显式固定为 `eol=crlf`，并恢复对应字节后，清单校验无需改哈希即可复现。

`apps/web/public/samples/soc-estimation-demo.csv` 的清单本来就是 LF 哈希，因此保持默认 LF，不纳入覆盖规则。

## 验证

- API candidate manifest：三份 runtime adapter 与 ONNX artifact 的 SHA-256/size 全部匹配。
- Web sample manifest：七份静态样例的 SHA-256/bytes 全部匹配。
- 下一步运行 API battery gateway/capability 与 Web battery sample 定向测试；若全量门禁仍失败，记录为独立问题。
