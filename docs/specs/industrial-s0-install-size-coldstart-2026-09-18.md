# 工业 S0 安装体积与冷启动实测(本机先行)

2026-09-18。补 [阶段差额](industrial-stage-delta-2026-09-18.md) S0 待办"干净断网 Windows 的完整安装体积、临时磁盘、首交互与可比冷启动预算"中**本机可先行的部分**。所有原始数据在 `test-output/industrial-s0-install-coldstart-20260918/`(`evidence.txt`、`install-volume.json`、`coldstart.json`、`network-byte-scan.json`、`measure-install-coldstart.py` 与逐次 stdout/stderr),由 `measure-install-coldstart.py`(python 3.13.9,纯标准库)一次生成,只读测量,未改 `apps/api/src`、`packages/**` 源码,未执行任何 cargo/pnpm 构建。

## 测量口径与诚实边界

- **非干净断网 VM**:开发机实测,其他 lane 可能并行编译,负载未隔离;数字是观测值,不是性能放行,也不冻结最终预算([权威计划](industrial-3d-format-work-plan-2026-09-16.md) §1.2 要求干净断网机实测后才冻结)。
- **OS 级断网未做**:以 PE 导入表 + 全镜像网络指标串字节扫描作为"本机无网依赖事实"的静态证据(见第 4 节);静态证据不能替代运行时断网验证,该项如实保留在阶段差额待办。
- **体积** = 实际字节,非磁盘占用;目录为递归求和 + 确定性 manifest SHA-256。
- **冷启动** = 暖 OS 文件缓存下 fresh-process 时间(python `perf_counter` 包 `subprocess.run`,stdin=DEVNULL,进程创建→退出),3 轮轮转;不是物理冷缓存。
- `deep-engine-native.exe` 与 `cadconvert.exe` 为 **debug** 构建(本任务禁止 cargo 全量构建,release 未测);其余研究件为 Release。

## 1. 当前分发物体积清单(实测)

| 分发物 | 字节 | MiB | 属性 | SHA-256(前16) |
| --- | ---: | ---: | --- | --- |
| `apps/api/dist/industrial-worker/industrial-worker-host.exe` | 621,056 | 0.59 | release,static CRT | `32d0e9ab4c4de1dd` |
| `apps/api/dist/industrial-worker/`(含 manifest.json,2 文件) | 622,207 | 0.59 | 目录 | `a83640b4636196de` |
| `packages/deep-engine-native/target/debug/deep-engine-native.exe` | 36,744,192 | 35.04 | **debug** | `2c02d478b82785a8` |
| `apps/api/dist/dashboard-content-compiler/`(4 文件) | 7,640,645 | 7.29 | Node .mjs 分发物 | `f1262449131c4284` |
| `apps/api/dist/native-scene-compiler/`(3 文件) | 1,352,534 | 1.29 | Node .mjs 分发物 | `b759d47af61865ed` |
| `e57-reader.exe`(libE57Format 3.4.0 + Xerces 3.3.0,Release) | 2,903,040 | 2.77 | 研究件 | `5c0d32c330798003` |
| `readlaz.exe`(laz-perf 3.4.0) | 2,940,736 | 2.80 | 研究件 | `da1486ab4c8509f7` |
| `example_read.exe`(openNURBS v8.35,Release) | 3,418,112 | 3.26 | 研究件 | `df7ec6d92f54f5cf` |
| `3dm-source-audit.exe` | 3,514,368 | 3.35 | 研究件 | `638eb25fd72bb0ee` |
| `rvt-source-identity.exe`(inspect 口径) | 827,392 | 0.79 | 研究件 | `b90fc3e9f95a51d3` |
| `cadconvert.exe`(X_T/STEP→GLB/USDZ,**debug**) | 9,041,408 | 8.62 | 研究件 | `99c0a3d745acfbf4` |
| `cadmpeg.exe`(SW sldprt inspect,Release) | 35,836,928 | 34.17 | 研究件(temp target) | `14de5287e42a2756` |
| **合计(以上全部)** | **104,841,562** | **99.99** | | |

逐文件完整 SHA-256 见 `install-volume.json`;目录行 manifestSha256 = 排序 `relpath:bytes:filesha256` 行串的 SHA-256。交叉核对:worker-host SHA 与其 `manifest.json` 一致;e57-reader SHA 与 `test-output/industrial-e57-negative-20260918/evidence.txt` 一致;cadmpeg SHA 与 [SW S0](industrial-solidworks-s0-2026-09-18.md) 一致;openNURBS/3dm-audit/rvt/cadconvert 字节数与 `test-output/industrial-s0-rss-20260917/SUMMARY.md` 一致。

## 2. 与预算对照(work-plan §1.2 初始目标)

结论先行:**当前没有任何格式 pack 组装物存在,只有单件 CLI/分发物;单件均远低于对应 pack 初始上限,"未超"成立,"预算达标"不成立——预算判定只能等 pack 组装后在干净断网机做。** "当前体积 X / 预算 Y / 差 Z"逐行如下(预算单位按 MiB 保守解读;按十进制 MB 解读余量更大,结论不变):

| 预算条目 | 预算 Y | 当前实测 X | 差 Z | 判定 |
| --- | --- | --- | --- | --- |
| `pointcloud-pack` | 150 MB 内 | e57-reader 2.77 MiB + readlaz 2.80 MiB = 5.57 MiB | 余量 ≥144 MiB | 未超;pack 未组装,不判达标 |
| `cad-geometry-pack` | 200 MB 内 | cadconvert(debug)8.62 MiB | 余量 ≥191 MiB | 未超;pack 未组装;debug→release 体积还会下降 |
| `bim-rvt-pack` | 100 MB 内 | rvt-source-identity(inspect)0.79 MiB | 余量 ≥99 MiB | 未超;构件解码 worker 未实现,pack 未组装 |
| `solidworks-pack` | S0 前不承诺体量 | cadmpeg(release)34.17 MiB(记录在案) | — | 无预算可比;未过可复现构建门槛前不随包发布 |
| `studio-core` | 无数字预算(原文"保持当前核心包级别,不因新增格式引入大型 CAD 内核") | worker 0.59 + dashboard compiler 7.29 + native compiler 1.29 + deep-engine-native(debug)35.04 = 44.2 MiB | — | **未定义数值预算**;建议值见下 |
| 首交互/临时磁盘/干净断网安装 | 要求干净断网机实测 | 未做 | — | 保留待办,不据本机数字宣称 |

**建议值(非承诺,附依据;正式冻结仍按 work-plan §1.2 在干净断网机复测):**

- `studio-core` 格式运行层预警线 ≤50 MB:依据为当前已测四件合计 44.2 MiB、其中最大件还是 debug 构建;release 化后预期下降,50 MB 留 ~13% 余量。
- `deep-engine-native.exe` release 单件预警线 ≤50 MB:依据为 debug 实测 35.0 MiB(含 wgpu/winit 全量符号),同量级 Rust release CLI(cadmpeg 34.2 MiB)佐证量级。
- 冻结前新增任何 pack 依赖必须先过 [许可闭包](industrial-s0-license-closure-2026-09-18.md) 缺口清单。

## 3. 冷启动实测(3 轮轮转,min / median ms,wall-time 进程创建→退出)

| 工件 | 参数 | min / median ms | exit | 无参行为(实测) |
| --- | --- | ---: | --- | --- |
| industrial-worker-host.exe | `[]` | 5.304 / 5.628 | 2 | 读 stdin,EOF 报 `EOF while parsing a value…` 退出(其 CLI 即 JSON-on-stdin) |
| deep-engine-native.exe | `[--help]` | 60.719 / 65.548 | 0 | usage 打印;bare 无参会进 GUI 事件循环不退出,故用 `--help` 口径 |
| e57-reader.exe | `[]` | 9.498 / 10.084 | 1 | usage 拒绝 |
| cadmpeg.exe | `[]` | 56.168 / 57.539 | 2 | clap usage |
| readlaz.exe | `[]` | 9.279 / 11.059 | -1 | stderr `Usage: readlaz <file.laz>` |
| example_read.exe | `[]` | 210.741 / 212.627 | 0 | SYNOPSIS 打印 |
| 3dm-source-audit.exe | `[]` | 210.384 / 210.590 | 2 | 静默(stdout/stderr 0 字节) |
| rvt-source-identity.exe | `[]` | 7.759 / 8.453 | 1 | usage 错误 |
| cadconvert.exe | `[]` | 22.681 / 24.055 | 1 | usage 打印 |
| dashboard-content-compiler | node 24.18.1 `compiler.mjs []` | 176.345 / 178.001 | 0 | 静默退出 |

可比口径:本表是"进程初始化→无参退出"的**下界**口径,与 `industrial-s0-rss-20260917`(含真实解析工作)不同口径,不可混用。自洽性检查:cadmpeg usage 57 ms < 其真实样本 inspect 81–116 ms([SW S0](industrial-solidworks-s0-2026-09-18.md),Measure-Command 口径),量级一致。

**建议预算(非承诺,附依据):** 格式解析 CLI 无参 usage 退出 P50 ≤ 250 ms(当前最大观测 212.6 ms + ~18% 余量);deep-engine-native `--help` ≤ 150 ms(当前 65.5);industrial-worker-host ≤ 50 ms(当前 5.6);node compiler.mjs 无参 ≤ 300 ms(当前 178.0)。真实解析路径的首交互预算沿用 RSS 文档口径另行冻结。

## 4. 断网替代证据:本机无网依赖事实(静态)

OS 级断网不可行(子代理无 OS 防火墙/代理控制),按任务指示改记静态证据:

- **PE 导入表**(`install-volume.json` → `pe.importedDlls`):9 个 exe 导入 DLL 全部为 Windows 系统 DLL(kernel32/ntdll/ucrt `api-ms-win-crt-*`/vcruntime/GUI 系列 user32、gdi32、dxgi、dwrite、ole32、shell32、setupapi、uiautomationcore 等);`ws2_32`/`wsock32`/`wininet`/`winhttp`/`urlmon`/`dnsapi`/`rasapi32` 0 导入。
- **导入函数名**:WSAStartup/connect/getaddrinfo/WinHttp* 等网络 API 名 0 命中。
- **全镜像字节扫描**(`network-byte-scan.json`,覆盖 LoadLibrary 动态加载不可见于导入表的情形):22 个网络指标串真实命中 0;3 处 `schannel` 经上下文核对均为 `channels`/`ChannelSample`/`TessellationChannel` 子串误命中。
- **http(s):// 字符串**:均为规范/命名空间/仓库 URI(如 `http://www.astm.org/COMMIT/E57/2010-e57-v1.0`、`http://www.w3.org/2000/xmlns/`、`https://github.com/gfx-rs/wgpu`),无服务端点。
- worker-host:`manifest.json` `"crt":"static"`,导入面仅 `kernel32`/`ntdll`/`api-ms-win-core-synch-l1-2-0`。
- **局限(如实)**:静态证据不能证明运行时无网行为;"干净断网 Windows 完整安装 + 首交互 + 临时磁盘"仍待干净机验收,保留在阶段差额待办。

## 5. 复现

```text
python test-output/industrial-s0-install-coldstart-20260918/measure-install-coldstart.py
```

生成 `install-volume.json`、`coldstart.json` 及逐次 `cold-*.run*.{stdout,stderr}.txt`;`network-byte-scan.json` 由同目录交付的字节扫描段生成(见 `evidence.txt` 尾注)。
