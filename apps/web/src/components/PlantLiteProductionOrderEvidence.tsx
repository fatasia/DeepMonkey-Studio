import { CalendarCheck2 } from "lucide-react";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";

export function PlantLiteProductionOrderEvidence({ result }: { result: PlantLiteStudyRecord }) {
  const orders = result.model?.productionOrders ?? [];
  const metrics = result.outcome.productionOrderMetrics95;
  if (!orders.length || !metrics) return null;
  const planned = orders.reduce((sum, order) => sum + order.quantity, 0);
  const weightedOnTime = planned ? orders.reduce((sum, order) => sum + (metrics[order.id]?.onTimeFulfillmentRate.mean ?? 0) * order.quantity, 0) / planned : 0;
  return <section className="plant-order-evidence">
    <header><span><CalendarCheck2 size={14} /><strong>订单交付证据</strong></span><small>{orders.length} 单 · {planned} 件计划 · 仿真口径</small></header>
    <div className="plant-order-summary"><span><small>计划准交</small><strong>{percent(weightedOnTime)}</strong></span><i>未完工件保留在分母中</i></div>
    <div className="plant-order-rows">{orders.slice(0, 12).map((order) => {
      const metric = metrics[order.id];
      if (!metric) return null;
      return <article key={order.id} className={metric.onTimeFulfillmentRate.mean < 1 ? "at-risk" : "on-time"}>
        <span><strong>{order.name}</strong><small>{order.quantity} 件 · 交期 {order.dueMinute} 分</small></span>
        <span><small>完成</small><b>{percent(metric.completionRate.mean)}</b></span>
        <span><small>准交</small><b>{percent(metric.onTimeFulfillmentRate.mean)}</b></span>
        <span><small>全部完成概率</small><b>{percent(metric.fullyCompletedRate.mean)}</b></span>
        <span><small>观测拖期</small><b>{metric.observedTardinessMinutes.mean.toFixed(1)} 分</b></span>
      </article>;
    })}</div>
    {orders.length > 12 ? <small>当前先展示 12 单，完整 {orders.length} 单指标请导出证据包查看。</small> : null}
    <footer>完成后按末件完工计算拖期；未完成且已过期时按本次仿真终点计算。非 ERP/MES 实绩。</footer>
  </section>;
}

function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
