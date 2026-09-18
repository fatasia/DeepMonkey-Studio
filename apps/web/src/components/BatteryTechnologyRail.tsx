export function BatteryTechnologyRail({ nativeRuntime }: { nativeRuntime: boolean }) {
  return (
    <section className="battery-technology-rail" aria-label="电池多物理推理架构">
      <div className="battery-technology-heading">
        <div>
          <span>AI 电池分析 · 原生推理</span>
          <strong>SPM-PINO 多物理神经算子 <b>×</b> TwinMoE 风险路由</strong>
        </div>
        <span className={`battery-native-runtime ${nativeRuntime ? "is-ready" : ""}`}>
          <i aria-hidden="true" />Rust · ONNX Runtime{nativeRuntime ? " · 已连接" : ""}
        </span>
      </div>
      <div className="battery-route-map">
        <article>
          <span>01</span>
          <div><strong>工况序列</strong><small>I · T · Δt · Chemistry</small></div>
        </article>
        <i aria-hidden="true" />
        <article className="is-operator">
          <span>02</span>
          <div><strong>SPM-PINO</strong><small>电化学 · 热 · 退化场</small></div>
        </article>
        <i aria-hidden="true" />
        <article className="is-router">
          <span>03</span>
          <div><strong>TwinMoE</strong><small>域判断 · 物理残差 · 专家分歧</small></div>
        </article>
        <i aria-hidden="true" />
        <article>
          <span>04</span>
          <div><strong>主轨迹</strong><small>轻专家 / 谱算子 / SPM 回退</small></div>
        </article>
      </div>
      <div className="battery-twin-capabilities" aria-label="数字孪生在线能力">
        <span>在线状态同化</span>
        <span>10 分钟多物理推演</span>
        <span>迁移校准门禁</span>
        <span>CLF-CBF 影子投影</span>
      </div>
    </section>
  );
}
