# N5 尾项核查与范围锁定(2026-10-02,主线程)

> 估时表原口径:N5"第三方 GLB unlit/无 TANGENT profile 的导入/生成/损失处理,避免零配置样板被拒"(4-8h,范围先核查)。

## 已有(不重建,三项全覆盖)

1. **无 TANGENT 自动生成**:`decodeTexturedGlb.test.ts`(171 行"generates a real tangent basis when a normal-mapped glTF omits TANGENT")+`tangentSpace.ts` generateTangents/validateTangentBasis——法线贴图模型缺 TANGENT 时生成真实切线基,生产实现。
2. **unlit/clearcoat 可选扩展 fallback**:`optionalMaterialFallback.ts`——KHR_materials_unlit/KHR_materials_clearcoat 显式投影到核心 glTF fallback;required extension 维持 fail-closed;调用方文档不变异。
3. **零配置不被拒**:`decodeTexturedGltf.ts::geometryDocument`——extensionsUsed/extensionsRequired 剔除白名单(SCALAR_MATERIAL_EXTENSIONS)外的条目后继续解码,**未知/可选扩展被剔除而非拒绝**,零配置样板可导入。
4. 损失处理:损失码在 T22 工业格式域已有(26 错误码+10 损失码),glTF 域以"可选扩展显式 fallback+未知扩展剔除"形态覆盖。

## 结论

N5 **核查行关闭,无剩余实现包**——估时表 4-8h 的三项(unlit/无 TANGENT/零配置)全部已是生产实现。合并到本行的 T12"稳定语义绑定"随 T12 关闭一并了结(T12UV 已验)。
