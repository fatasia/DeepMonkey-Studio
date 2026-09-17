# 3DM 纹理资源可用性与分发审计

本片新增只读、哈希绑定、目录受限的资源读取夹具；真实样本仍保持 identity-only，没有嵌入未证明的图片或材质。

## 检索证据

- 在 `D:/Download` 和 `data/external-assets` 用 `rg --files --hidden --no-ignore` 检索 loose files，没有找到 `bump_grit.png` 或同名变体。没有声称扫描每个压缩包内部。
- 已固定 rhino3dm v8.32.0 缓存里仅有文档/icon 图片，没有样本引用的图片。meshWithTexture 的引用仍是 macOS 应用目录绝对路径，relativePath 为空，mapping channel 为 WCS box。
- 网络精确查询 `"bump_grit.png"` 与官方仓库限定查询没有结果；随后检查 [McNeel developer samples](https://github.com/mcneel/rhino-developer-samples/tree/8462fc3487f8b7a58595ef73f6a5c09f92717f60/rhino3dm/js/SampleViewer/02_advanced)。该固定 revision 有 3DM 与配套图片，但其查看器 `script.js` 先创建材质、加载任选 PBR 图组，再将此材质覆盖给每个 child。这不能证明图片来自 3DM 源材质引用。
- 下载并实读 `hello_mesh.3dm`：935,688 字节，SHA-256 `5a22a1a79df6a6aa755adc846f0cedbfe2a047e3844cd43de691df843e2db9d3`；6 对象、6 材质、0 texture 引用，验证了上述替代路径不符合源纹理要求。
- 同 revision 的 [License.md](https://github.com/mcneel/rhino-developer-samples/blob/8462fc3487f8b7a58595ef73f6a5c09f92717f60/License.md) 有软件及附属文档的使用/分发授权，但本片未把它自动扩大为所有第三方图片的独立授权结论。下载 license SHA-256 `1a9a88d66b24c1609493484bdc93455b5be7a489407b07b568b79076472238f2`。查看器源码 Git blob `b5a6966fa4365fcbdd15347c3a8b80f8c348b5f4`，由官方 API 复核。

原始样本、license 与生成证据只在 gitignored `test-output/3dm-source-audit/developer-sample/`。第一次 PowerShell 下载模型连接被重置，curl 重试成功；查看器源码正文已读，后续落盘请求被重置，采用固定 Git blob 记录。没有商业程序或云转换调用。

## 读取合同与验证

`scripts/fixtures/3dm-texture-resource.mjs` 只接受显式审批的 root-relative 资源记录：源 URL、SHA-256、分发审查状态、license ID 与本地 license 文件 SHA 都必须齐全。记录只表达上游调用者完成的授权审查，不自动判断法律授权。

实现拒绝绝对/UNC/盘符路径、`..`、ADS、百分号编码歧义、反斜杠、Windows 设备名、尾空格/点；realpath 后再次检查目录归属，拒绝 junction 逃逸；来源只接受无凭据、无 fragment 的 HTTPS URL，license ID 有界；限制资源字节预算（默认 8 MiB，上限 64 MiB）、license 256 KiB；有限读取后检查文件变化与 SHA。没有 basename 猜配、目录外自动搜索、URL 下载或执行资源的逻辑。它验证资源字节，不冒充图片解码器，也未声称可防御敌对进程在每个系统调用间竞态替换整个目录树。

4 项测试通过：合法受限字节、路径拒绝矩阵、缺失/hash/license/预算失败、真实 Windows junction 逃逸。测试使用明确标注的非图像合同字节，不是纹理完成证据。

真实负向审计 `audit-3dm-texture-availability.mjs` 复核源 JSON hash，将 meshWithTexture 的真实绝对引用送入读取器，得到 `resource-path-unsafe`；另实读已固定 hello_mesh 验证 0 texture 引用。结果为 `test-output/3dm-source-audit/texture-availability-evidence.json`。

```powershell
node --test scripts/fixtures/3dm-texture-resource.test.mjs
node scripts/fixtures/audit-3dm-texture-availability.mjs
```

## 后续可执行项

继续取得能逐项证明“3DM 源纹理引用 → 图片字节 → 分发依据 → 正确映射”的样本，再接入图片解码预算与 GLB embedding。当前 WCS box 映射还需独立转换验证；换一张可用图片并不能解决源外观对应关系。本片没有提高产品能力等级，没有修改产品依赖或共享总账。
