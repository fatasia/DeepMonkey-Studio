# 构建 / 运行 / 诊断命令（复用项目现有命令,不新造）

前置:Node ≥ 24、pnpm(仓内已装)、Chrome(浏览器门;或 `SDK_GATE_CHROME` 指定)。

| 目的 | 命令 |
|---|---|
| 构建 SDK | `pnpm --filter @bim-studio/deep-engine build` |
| 8 模板一键验收门 | `pnpm gate:hc7p2-templates` |
| 等价直跑 | `node templates/deep-engine-3d/scripts/gate-templates.mjs` |
| 版本 pin 漂移检测 | `node --test templates/deep-engine-3d/scripts/version-pin.test.mjs` |
| Skill 分发(双客户端) | `node templates/deep-engine-3d/scripts/distribute-skill.mjs` |
| Skill 分发校验 | `node templates/deep-engine-3d/scripts/verify-distribution.mjs` |
| 套件单测(pin+分发) | `cd templates/deep-engine-3d && node --test scripts/*.test.mjs` |

单模板快速迭代(仓外消费者工作区,门日志里有当次 workspace 路径):

```bash
cd <consumer-workspace>
node <repo>/node_modules/typescript/bin/tsc -p templates/<id>/tsconfig.json   # Node 配置+emit
node out/node/templates/<id>/node.js                                          # 无头断言
node <repo>/node_modules/typescript/bin/tsc -p templates/<id>/tsconfig.browser.json  # 浏览器类型检查
```

## 门产物判读(test-output/hc7p2-templates-20261002/)

- `report.json` — `status: "passed"`、每模板 frames/pixels/bundle bytes
- `<id>-rendered.png` — 渲染态截图(dispose 前),视觉核对以它为准
- `<id>-browser.png` — 协议收尾截图(dispose 后画布已清空,属预期)
- `tsc-node-<id>.log` / `tsc-browser-<id>.log` / `node-<id>.log` — 失败定位第一入口
- `<id>-browser-metafile.json` — bundler 输入清单(证明只用 SDK dist,无 react/three/src)

## 黑帧/失败排查顺序

1. `node-<id>.log` — 场景构造/断言失败(Node 侧先红先修)
2. `tsc-browser-<id>.log` — WebGPU 类型/API 误用
3. `report.json` 的 browser 段 — `pixelEvidence.distinctFromCorner` 低=没画出东西;黑帧原因看 harness 抛错文本(设备丢失/校验错误/未发布)
4. 相机看空:`eye()/target/extent` 是否把场景放到画外;先调 radius/height
