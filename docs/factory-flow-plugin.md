# Factory Flow 插件（M8 最小纵向切片）

`@bim-studio/factory-flow-plugin` 是可选插件，不属于 2D、3D、数据、转换、保存或发布的默认启动链路。未注册、未启用或启用失败时，核心功能不受影响。

## 当前能力

- 轻量确定性离散事件引擎：`Source → Process / Buffer / AGV → Sink`。
- 控制：运行、暂停、0.1–100 倍速、复位和仿真时钟。
- 指标：吞吐量、每小时吞吐、平均周期、在制品（WIP）、资源利用率和瓶颈。
- AGV 数据源契约：`realtime`、`simulation`、`replay` 可运行时切换；数据源只负责位姿，物流事件引擎保持独立。
- 与 `@bim-studio/plugin-runtime` 的 manifest、注册、启用、禁用和故障隔离机制集成。

## 宿主接入

宿主显式注册后才会实例化：

```ts
registry.register(
  FACTORY_FLOW_PLUGIN_MANIFEST,
  createFactoryFlowPluginFactory({
    model,
    agvMotionSources: [simulationSource, realtimeSource, replaySource],
    onActivate(service) {
      mountFactoryPanel(service);
    },
    onDeactivate() {
      unmountFactoryPanel();
    }
  })
);
```

注册不会自动启用。`registry.enable("bim-studio.factory-flow")` 才创建引擎；禁用时引擎暂停并复位所有 AGV 数据源。激活异常由插件运行时标为 `faulted`，不向其他插件或编辑器核心扩散。

## 有意不包含

该切片不包含 3D 路径绘制、PLC/MQTT 连接器、排产优化、碰撞/物理、统计置信区间和 Plant Simulation 全量对象库。这些均可在不改核心编辑器的前提下按插件能力继续增加。
