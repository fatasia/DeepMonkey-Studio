# 工业格式 PLAN-02:Windows 离线试构建与体量记录

日期:2026-09-17。状态:**第一批候选库离线试构建已实测完成;结论按库分化;RVT 语料盘点完成**。
上游计划:[工业三维格式接入工作计划](./industrial-3d-format-work-plan-2026-09-16.md)。
语料与依赖锁定:[PLAN-01/02 锁定报告](./industrial-format-plan01-02-lock-2026-09-16.md)。

本报告全部数据为 2026-09-17 在本机(D:\,Windows 10.0.22621 x64,24 核)实际执行所得,
无任何"预计"值。所有构建产物、日志与盘点 CSV 在本地忽略目录
`data/external-assets/industrial-format-plan/build-trial/`(不入 Git)。

## 1. 工具链事实(试构建环境)

| 项 | 实测值 |
| --- | --- |
| C++ 编译器 | MinGW-w64 GCC 15.1.0(x86_64-win32-seh,`D:\Soft\SDK\mingw64`) |
| make | mingw32-make(Git Bash xargs -P 并行驱动编译,未用 makefile) |
| CMake | **本机不存在**(常见安装位置与 VS 目录均无) |
| MSVC | **本机不可用**(`C:\Program Files (x86)\Microsoft Visual Studio\2019` 只剩 Installer,无 cl.exe/vcvarsall) |
| Node/pnpm | node v24.18.1,pnpm v11.18.0(带本地 store,不含候选库依赖) |
| Rust | rustc 1.93.0(2026-01-19) |
| Python | anaconda3(仅用于验证,未进入构建链) |

**结论级事实:本机唯一可用的 C++ 工具链是 MinGW GCC 15.1;凡上游只支持 MSVC 的库,本批只能给出"MSVC 路径待验证"的记录,不能给绿。**

## 2. 候选库逐个结论(总览)

| 候选库(锁定版本) | 试构建结果 | 工件体量 | 最小示例 |
| --- | --- | --- | --- |
| openNURBS v8.35.26251.13001 | **失败(可编译 192/199 TU,不可链接)** | 静态库 13.5 MB(213 成员,不可用) | example_read 头文件可消费;无可运行程序 |
| laz-perf 3.4.0 | **成功(零补丁)** | 静态库 0.67 MB(15 成员) | readlaz 实测 2 个样本,92/130 ms,峰值 RSS 6.9/14.6 MB |
| libE57Format v3.4.0 | **被依赖阻断(缺 XercesC 3.2)** | 未产出 | 公共头 6 个全部编译通过(手工补生成头后) |
| 3d-tiles-renderer v0.5.2(TS) | **被依赖阻断(离线缺 npm 包)** | 未产出 | — |
| PDAL 2.10.2 | **未构建(源码包未锁定在本地)** | — | — |
| rhino3dm v8.32.0 | **未构建(3 个 submodule 为空,须在线拉取)** | — | — |
| rvt-rs v0.1.2(Rust) | **失败(离线缓存缺 crate 源码)** | 未产出 | — |
| parasolid-kit v0.2.0(Rust) | **失败(同上)** | 未产出 | — |
| cadmpeg v0.6.0(Rust) | **失败(同上)** | 未产出 | — |

## 3. openNURBS v8.35.26251.13001(MinGW GCC 15.1)

### 3.1 命令(实测原文)

```bash
# 库:199 个根级 opennurbs_*.cpp,16 路并行(xargs -P 16)
g++ -std=c++14 -O2 -DNDEBUG -DUNICODE -D_UNICODE \
    -DWINVER=0x0A00 -D_WIN32_WINNT=0x0A00 -D_WIN32_IE=0x0A00 \
    -DON_COMPILING_OPENNURBS -DOPENNURBS_PUBLIC -D_GNU_SOURCE -I. \
    -c <file> -o <file>.o
# zlib(11 个 .c,上游 makefile 宏)与 android_uuid(10 个 .c)分别同参编译
gcc -O2 -DNDEBUG -DMY_ZCALLOC -DZ_PREFIX -c <zlib/*.c>
# 打包
ar rcsv libopennurbs_public.a opennurbs_*.o zlib/*.o android_uuid/*.o
# 示例(库消费者,不得带 -DON_COMPILING_OPENNURBS/-DOPENNURBS_PUBLIC)
g++ -std=c++14 -O2 -DUNICODE -D_UNICODE -I. -c example_read/example_read.cpp
```

### 3.2 结果时间线

1. **按上游 makefile 宏(无 UNICODE)第一轮:189/199 编过,10 文件失败。**
   首错原文(`opennurbs_lock.h:118`,GCC 15 的 libstdc++ 将 `atomic<int>` 整数构造声明为 explicit,拒绝拷贝初始化):

   ```text
   opennurbs_lock.h:118:44: error: use of deleted function 'std::atomic<int>::atomic(const std::atomic<int>&)'
     118 |   std::atomic<int> m_lock_value = ON_Lock::UnlockedValue;
   ```

   `-fpermissive` 实测无效(同一错误照报)。
2. **构建副本补丁 1 处**(仅 data/ 下构建副本,未触碰任何生产源码;与上游
   `ON_RUNTIME_LINUX` 分支语义一致,如实记录):
   `opennurbs_lock.h` Windows 分支成员初始化 `= ON_Lock::UnlockedValue` 改为
   `{ ON_Lock::UnlockedValue }`(brace 直接初始化,MSVC/GCC 语义等价)。
3. **第二轮(补 `-DUNICODE -D_UNICODE -DWINVER=0x0A00 -D_WIN32_WINNT=0x0A00 -D_WIN32_IE=0x0A00`):192/199,剩 7 文件失败。**
4. **打包成功:`libopennurbs_public.a` = 14,154,696 字节(13.5 MB),213 成员(192 openNURBS + 11 zlib + 10 uuid)。**
5. **example_read.o / example_ud.o 编译通过**(公共头暴露面 GCC 下完全可消费)。
6. **链接失败:3,141 个 undefined reference**,全部来自上述 7 个缺失翻译单元
   (`ON_UuidCompare/ON_UuidIsNil/ON_CreateUuid`、`ON_qsort/ON_hsort`、
   `ON_wString::Format/FormatToString`、`ON_Locale::NumericLocalePtr`、
   `ON_XMLUserData`、`ON_FileReference::FullPathHash` 等)。

### 3.3 剩余 7 文件失败根因(逐个,均为上游平台分支未覆盖 MinGW)

| 文件 | 首错 | 根因 |
| --- | --- | --- |
| opennurbs_internal_defines.h(经 PRIVATE_CHECK 波及 render_content/xml 等) | `'L' was not declared` | `L#c` 字符串化拼接是 MSVC 预处理器扩展,GCC 不认 |
| opennurbs_file_utilities.cpp | `'KNOWNFOLDERID' was not declared` | MinGW 的 Shlobj.h 未拉入 knownfolders 定义;另有 `wchar_t*→LPSTR` 窄宽混淆 |
| opennurbs_locale.cpp / opennurbs_string_format.cpp | `'sprintf_l'/'vsnprintf_l' was not declared` | MSVC CRT 专有函数;上游 GNU 分支只在 `ON_RUNTIME_LINUX` 下用 `sprintf`,GNU+Windows 落入无实现组合 |
| opennurbs_sort.cpp | `'qsort_r' was not declared` | glibc 专有(`_GNU_SOURCE` 分支),MinGW CRT 无 |
| opennurbs_xml.cpp | `'localtime_r' was not declared` | POSIX 专有;非 MSVC 分支直接调用,MinGW 无 |
| opennurbs_uuid.cpp | `#error TODO - generate uuid` | CoCreateGuid 分支限定 `ON_COMPILER_MSC`,MinGW 落入"你必须提供 UUID 生成方式"的硬错误分支 |

### 3.4 体量与耗时

- 库编译 43 s(24 核 16 路,-O2);zlib+uuid 2 s;打包即出 13.5 MB 静态库。
- 构建树共 169 MB(含 .o 与副本源码)。
- 无 RSS 记录:**无可运行程序**(链接失败),这是失败结论的一部分,不虚构。

### 3.5 结论

- **MinGW-w64 GCC 15.1 下 openNURBS v8.35 不可构建到可链接状态**;缺口是 7 个
  文件的平台分支移植(`sprintf_l` 家族/`qsort_r`/`localtime_r`/UUID 生成/KNOWNFOLDERID/`L#c` 宏),
  不是构建定义能解决的小补丁。
- 上游官方支持组合为 MSVC(Windows)/gcc(Linux)/clang(Apple);本机无 MSVC。
- **后续路径二选一**:① 在有 MSVC 的机器上用官方 vcxproj/CMake 复测(体量/RSS 记录顺延);
  ② 若坚持 MinGW,需先立项一个有边界的移植包(7 文件 diff + 上游跟踪),PLAN-02 范围内不擅自实施。

## 4. laz-perf 3.4.0(Apache-2.0)——成功,零补丁

### 4.1 命令

```bash
# 库:lazperf/*.cpp + lazperf/detail/*.cpp(15 个 TU,16 路)
g++ -std=c++14 -O2 -DNDEBUG -Ilazperf -c <file> -o <file>.o
ar rcsv liblazperf_s.a lazperf/*.o lazperf/detail/*.o
# 上游自带示例 readlaz/point10,-static 生成自包含 exe(MinGW 默认动态链 libstdc++
# 在无 MinGW PATH 的进程下报 0xC0000139 入口点缺失,已实测并改静态链接)
g++ -std=c++14 -O2 -Ilazperf -c examples/readlaz.cpp
g++ -static readlaz.o -L. -llazperf_s -o readlaz.exe
```

### 4.2 结果与体量

- 静态库 `liblazperf_s.a` **707,182 字节(0.67 MB)**,15 成员;库编译 3 s。
- `readlaz.exe` 2.9 MB / `point10.exe` 2.8 MB(-static 自包含)。

### 4.3 最小示例实测(读锁定样本,峰值 RSS 为 1 ms 轮询采样的近似值)

| 样本(PLAN-01 锁定) | 大小 | 退出码 | 耗时 | 峰值 RSS |
| --- | --- | --- | --- | --- |
| autzen_trim.laz | 603,353 B | 0 | 92 ms | 6.9 MB |
| 1.2-with-color.copc.laz | — | 0 | 130 ms | 14.6 MB |

### 4.4 结论

- **laz-perf 3.4.0 在 MinGW GCC 15.1 下开箱即编、示例可跑**,LAZ/COPC 解码正常。
- 工件体量(0.67 MB)对 `pointcloud-pack` 150 MB 预算几乎无压力;header-only 面清晰
  (安装头仅 6 个:lazperf.hpp/filestream.hpp/header.hpp/readers.hpp/vlr.hpp/writers.hpp + lazperf_base.hpp)。

## 5. 其余锁定候选状态(逐个记录,失败/未构建同样是交付物)

### 5.1 libE57Format v3.4.0(BSL-1.0)——被 XercesC 依赖阻断

- 顶层 CMakeLists 第 80 行 `find_package( XercesC 3.2 REQUIRED )`,第 214 行
  `target_link_libraries( E57Format PRIVATE XercesC::XercesC )`,README 依赖清单亦列明
  Xerces-C++(XML 解析)。**XercesC 不在 PLAN-01 锁定工件中**,本机离线无法构建库本体。
  这是 PLAN-01 锁定的遗漏项,建议补记:Xerces-C 3.2.x 需进入下一批依赖锁定。
- **头文件暴露面已验证**:CMake 生成头 `E57Export.h` 按静态库语义手工等效生成
  (E57_DLL 展开为空;生成脚本 `cmake/E57ExportHeader.cmake` 的静态分支语义),
  6 个公共头 `E57Format/E57Exception/E57Version/E57SimpleData/E57SimpleReader/E57SimpleWriter`
  在 GCC 15(-std=c++17)下全部编译通过。头层面 API 自洽,无平台缺口暴露。

### 5.2 3d-tiles-renderer v0.5.2(Apache-2.0,TS)——离线缺 npm 依赖

- `pnpm install --offline --ignore-workspace --ignore-scripts` 失败,首错:

  ```text
  [ERR_PNPM_NO_OFFLINE_META] Failed to resolve @babylonjs/loaders@>=8.47.2 <9.0.0-0
  in package mirror C:\Users\rain\AppData\Local\pnpm-cache\v11\metadata\registry.npmjs.org\...
  ```

- 运行时依赖 `@mapbox/vector-tile`、`pbf`、`pmtiles` 与 peer(react/three/babylon)均不在本地
  store,亦不在 PLAN-01 锁定工件。构建入口为 `vite build --config vite.lib-config.js`,
  依赖装不上则无法进入。**3D Tiles 方向本批没有可离线构建的候选**(锁定清单中无 C++ 实现)。

### 5.3 PDAL 2.10.2——未构建

- 本地仅有官方 `PDAL-2.10.2-src.tar.bz2.sha256sum`(90 B),101,975,261 字节源码包
  超出 PLAN-01 单文件 100 MB 上限未下载。无源码即无构建,与锁定报告口径一致。

### 5.4 rhino3dm v8.32.0(MIT)——submodule 缺失,按约束跳过

- 解包 tarball 中 `src/lib/pybind11`、`src/lib/opennurbs`、`src/lib/draco` 三个 submodule
  目录全空(`.gitmodules` 声明在线 URL)。**必须在线拉取子模块才能配置构建**,按任务约束
  记录该事实并跳过。另注:rhino3dm 内嵌的 opennurbs 副本与 §3 为同源代码,MinGW 结论可参考。

### 5.5 Rust 系(rvt-rs / parasolid-kit / cadmpeg)——离线 cargo 实测,三者全部失败

三者均为 Rust 工程(edition 2024,均带 Cargo.lock;rustc 1.93.0 满足各自 rust-version),
统一执行 `cargo build --release --offline`(parasolid-kit/cadmpeg 限定核心 crate):

| crate | 命令 | 首错 |
| --- | --- | --- |
| rvt-rs v0.1.2 | `cargo build --release --offline` | `error: no matching package named 'pyo3' found` |
| parasolid-kit v0.2.0 | `cargo build --release --offline -p parasolid-core` | `error: no matching package named 'pyo3' found`(workspace 成员 parasolid-python 强制参与解析) |
| cadmpeg v0.6.0 | `cargo build --release --offline -p cadmpeg` | clap 版本解析失败(本地缓存无对应版本元数据) |

根因一致:**Cargo.lock 锁定了版本,但本地 cargo registry 缓存没有对应 crate 源码**,
离线模式下解析即失败,未进入编译。Rust 系候选要走通,需一次性
`cargo vendor` 或 `cargo fetch`(联网)把锁定的依赖树落盘,之后才能离线复现构建;
这属于下一批依赖锁定的动作,不在本批"不下载新依赖"约束内。

## 6. D 盘 RVT 盘点(只盘点文件与容器魔数,不解析内容)

两轮扫描,脚本与输出在 `build-trial/`:`inventory-rvt.ps1`(浅扫)、
`inventory-rvt-deep.ps1`(深扫)、`rvt-inventory.csv`、`rvt-inventory-deep.csv`。

### 6.1 覆盖范围与数量

| 轮次 | 范围 | 结果 |
| --- | --- | --- |
| 浅扫 | D:\ 顶层 27 个非排除目录,深度 4 | 5 个 RVT,0 个 RFA |
| 深扫 | 24 个工程目录(深度 8)+ 4 个下载目录(深度 4) | **37 个唯一 RVT,共 4,963.3 MB,0 个 RFA** |

排除目录(两轮一致):`$RECYCLE.BIN`、`System Volume Information`、`ProgramData`、
`Windows Kits`、`docker`、`server`、`system`、`AppData`、`Soft`、`AI`、`Tools`、`Linux`、
`temp`(深扫单独补扫)、`ttnet`、`win-tts`、`XBDATA`(深扫单独补扫)、`MailMasterData`
(下载目录 Download/BaiduNetdiskDownload/XBDATA/temp 深扫已按浅深度补扫)。

### 6.2 分布

- **28 个(约 4.5 GB)在 `D:\[已脱敏]\项目\[已脱敏]-[已脱敏]\素材\BIM\`**:
  [已脱敏]二 A/B 区、[已脱敏]车间二的真实工厂 BIM,**按土建(建筑/结构)与机电(F1/F2 机电模型)
  分文件、按楼层分目录**,并含 `.0001/.0003/.0011/.0014` 等版本备份文件——
  正好补 PLAN-01 指出的"RVT 学科覆盖不足"缺口(土建+机电同工程)。
- 7 个在 `D:\Documents\bim\bim-studio\`(test-model 4 个 Autodesk 官方样例:
  Snowdon Towers Architectural/rme(机电)/rac(建筑)/rst(结构)basicsample + PLAN-01 已锁
  `2024_Core_Interior.rvt` + B 示例模型)。
- 2 个在 `D:\Download`。

### 6.3 RVT 语料候选 Top 20(按体量,版本提示为 best-effort)

全部 37 个文件的版本读取采用"OLE 容器魔数 + 文件头 4 MB ASCII 扫描"的 best-effort 方式,
**37 个均为合法 OLE/CFB 容器(D0 CF 11 E0 A1 B1 1A E1),但 4 MB 窗口内均未检出
"Autodesk Revit …(Build: …)"版本字符串**;Revit 版本号存于 OLE 流内部,需流级解析
(olefile/自研 CFB reader),列入下一步,不在本批"只盘点"范围内。

| # | 大小 MB | 路径(节选,均相对 D:\) | 学科线索(文件名) |
| --- | --- | --- | --- |
| 1 | 593.00 | [已脱敏]\…\[已脱敏]二B区F1模型\土建\[已脱敏]二(11B区1~43轴)0701.ifc.RVT | 土建 |
| 2 | 568.41 | [已脱敏]\…\[已脱敏]二B区F1模型\土建\[已脱敏]二(11B区1~43轴)0701.ifc.0001.RVT | 土建(版本备份) |
| 3 | 568.41 | [已脱敏]\…\[已脱敏]二B区F2模型\土建模型\[已脱敏]二(11B区1~43轴)0701.ifc.RVT | 土建 |
| 4 | 417.10 | [已脱敏]\…\[已脱敏]二A区模型\一层\11A区1-31轴0617.ifc.RVT | 土建 |
| 5 | 409.63 | [已脱敏]\…\[已脱敏]二A区模型\一层\11A区1-31轴0617.ifc.0001.RVT | 土建(版本备份) |
| 6 | 231.09 | [已脱敏]\…\[已脱敏]车间二模型\一层模型\[已脱敏]车间二.ifc.RVT | 土建 |
| 7 | 190.74 | [已脱敏]\…\[已脱敏]车间二\一层模型\[已脱敏]车间二(辅梁,马道).ifc.RVT | 结构(辅梁/马道) |
| 8 | 144.32 | [已脱敏]\…\[已脱敏]车间二\一层模型\20260701-[已脱敏]车间二-一层模型.rvt | 土建 |
| 9 | 142.89 | [已脱敏]\…\[已脱敏]车间二\一层模型\20260701-…-一层模型.0014.rvt | 土建(版本备份) |
| 10 | 140.09 | [已脱敏]\…\[已脱敏]二A区模型\一层\[已脱敏]A区.rvt | 土建 |
| 11 | 139.91 | [已脱敏]\…\[已脱敏]二A区模型\一层\[已脱敏]A区.0003.rvt | 土建(版本备份) |
| 12 | 118.91 | [已脱敏]\…\[已脱敏]二B区F2模型\土建模型\[已脱敏]B区.rvt | 土建 |
| 13 | 118.91 | [已脱敏]\…\[已脱敏]二B区F1模型\土建\[已脱敏]B区.rvt | 土建 |
| 14 | 100.61 | [已脱敏]\…\[已脱敏]二B区F1模型\[已脱敏]二-B区机电模型F1.rvt | **机电** |
| 15 | 100.61 | [已脱敏]\…\[已脱敏]二B区F1模型\[已脱敏]二-B区机电模型F1.0011.rvt | 机电(版本备份) |
| 16 | 98.61 | [已脱敏]\…\[已脱敏]车间二\一层模型\[已脱敏]车间二(辅梁,马道).ifc.0001.RVT | 结构(版本备份) |
| 17 | 90.50 | [已脱敏]\…\[已脱敏]车间二\一层模型\[已脱敏]车间-土建模型.rvt | 土建 |
| 18 | 90.30 | Documents\bim\bim-studio\test-model\Snowdon Towers Sample Architectural.rvt | 建筑(Autodesk 官方) |
| 19 | 89.51 | [已脱敏]\…\[已脱敏]二A区模型\一层\[已脱敏]二A区-1-14.rvt | 土建(分轴段) |
| 20 | 89.42 | [已脱敏]\…\[已脱敏]二A区\一层\[已脱敏]二A区-机电模型(一层链接IFC).0001.rvt | **机电(含 IFC 链接)** |

完整 37 条清单:`build-trial/rvt-inventory-deep.csv`(路径/字节数/MB/扩展名/修改日期/版本提示)。

### 6.4 盘点边界(诚实声明)

- 未扫描被排除的系统/软件目录(见 6.1);C 盘及仓库外网络盘不在范围。
- 未做 RVT 流级版本解析与内容解析(任务约束"不解析内容,只盘点")。
- `.rfa` 全盘 0 命中,族语料缺口仍在。
- [已脱敏]目录含同名 `.0001` 备份文件,入选候选时需人工确认版本主次,不能按文件名机械取舍。

## 7. 下一步建议(按优先级)

1. **MSVC 复测矩阵(最高优先)**:openNURBS 与 libE57Format 的构建结论都被"本机无 MSVC/cmake"
   卡住。在有 Visual Studio 2022 的机器上用官方工程(CMake 生成)复测 openNURBS + libE57Format
   (+ XercesC 3.2.x 一起离线构建),记录二进制 hash、安装体量、冷启动、峰值 RSS——这是
   PLAN-01 停止条件 #1 的正解路径。
2. **补 PLAN-01 锁定缺口**:Xerces-C 3.2.x(libE57Format 硬依赖);rhino3dm 的
   pybind11/opennurbs/draco submodule(换用带 submodule 的归档或记录 commit 固定值);
   PDAL 完整源码包(101,975,261 B,已有官方 sha256sum)。
3. **RVT 语料收口**:从[已脱敏] 28 个文件中按"土建/机电 × F1/F2 × 版本主备"挑 8~10 个
   (约 2.5 GB)登记进 corpus-manifest.json 并计算 SHA-256;RVT 流级版本解析(reader)列为
   WP-RVT 的前置小任务;另补真实 `.rfa` 语料。
4. **3D Tiles 方向重新选型**:锁定清单里没有可离线构建的 C++ 3D Tiles 库;TS 侧
   3d-tiles-renderer 需要一次性在线装依赖后做 vendor 锁定(或私有 registry 快照),
   否则 WP-TILE 的 S0 无从开始。
5. **MinGW 移植包(可选,低优先)**:若产品决定用 MinGW 作为 Worker 工具链,openNURBS
   需要一个 7 文件的移植补丁包(§3.3 清单即工作量清单)并向上游提 issue;在此之前
   openNURBS 只能按"MSVC-only"管理。

## 8. 本次产物索引(均在 data/external-assets/industrial-format-plan/build-trial/,不入 Git)

| 产物 | 路径 |
| --- | --- |
| openNURBS 构建树 + 静态库 + 链接日志 | `opennurbs/`、`logs/opennurbs-lib-errors2.log`、`logs/opennurbs-link-errors.log` |
| laz-perf 构建树 + 库 + 可执行 | `laz-perf/`、`logs/lazperf-errors.log` |
| libE57Format 头文件探针 + 生成头 | `libe57format/`、`logs/e57-header-errors.log` |
| RVT 盘点脚本与结果 | `inventory-rvt*.ps1`、`rvt-inventory*.csv`、`rvt-inventory-deep-summary.txt` |
| 运行测量脚本 | `measure-run.ps1`(峰值 RSS 为 1 ms 轮询采样近似) |
