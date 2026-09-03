import { CalendarClock, Plus, Trash2 } from "lucide-react";
import type { PlantLiteModel, PlantLiteProductionOrder } from "@bim-studio/plant-lite-simulation";

export function PlantLiteProductionOrdersEditor({ model, onChange }: { model: PlantLiteModel; onChange: (model: PlantLiteModel) => void }) {
  const orders = model.productionOrders ?? [];
  const sources = model.nodes.filter((node) => node.kind === "source");
  const total = orders.reduce((sum, order) => sum + (Number.isFinite(order.quantity) ? order.quantity : 0), 0);
  const add = () => {
    const source = sources[0];
    if (!source) return;
    const id = uniqueOrderId(model);
    const order: PlantLiteProductionOrder = {
      id,
      name: `生产订单 ${orders.length + 1}`,
      sourceNodeId: source.id,
      ...(model.productTypes?.[0] ? { productTypeId: model.productTypes[0].id } : {}),
      quantity: 50,
      releaseMinute: 0,
      dueMinute: 480,
      priority: 0,
    };
    onChange({ ...structuredClone(model), productionOrders: [...orders, order] });
  };
  const update = (id: string, patch: Partial<PlantLiteProductionOrder>) => onChange({
    ...structuredClone(model),
    productionOrders: orders.map((order) => order.id === id ? { ...order, ...patch } : order),
  });
  const updateProduct = (id: string, productTypeId: string) => onChange({
    ...structuredClone(model),
    productionOrders: orders.map((order) => {
      if (order.id !== id) return order;
      if (productTypeId) return { ...order, productTypeId };
      const { productTypeId: _productTypeId, ...withoutProduct } = order;
      return withoutProduct;
    }),
  });
  const remove = (id: string) => {
    const next = orders.filter((order) => order.id !== id);
    const copy = structuredClone(model);
    if (next.length) copy.productionOrders = next;
    else delete copy.productionOrders;
    onChange(copy);
  };
  return <details className="plant-order-editor">
    <summary>
      <CalendarClock size={14} />
      <span><strong>生产订单与交期</strong><small>{orders.length ? `${orders.length} 单 · ${total} 件计划` : "可选 · 验证计划数量与准交风险"}</small></span>
      <em>{orders.length ? "已启用" : "未配置"}</em>
    </summary>
    <div className="plant-order-editor-body">
      <header><span>同一来料源共享节拍并按优先级投产；释放与交期从正式统计窗口起算，准交率以计划数量为分母。</span><button type="button" disabled={!sources.length || orders.length >= 200} onClick={add}><Plus size={13} />新增订单</button></header>
      {orders.map((order) => <article key={order.id}>
        <label className="order-name"><span>订单名称</span><input value={order.name} maxLength={120} onChange={(event) => update(order.id, { name: event.target.value })} /></label>
        <label><span>来料源</span><select value={order.sourceNodeId} onChange={(event) => update(order.id, { sourceNodeId: event.target.value })}>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
        {model.productTypes?.length ? <label><span>产品</span><select value={order.productTypeId ?? ""} onChange={(event) => updateProduct(order.id, event.target.value)}><option value="">按产品组合</option>{model.productTypes.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label> : null}
        <label><span>计划数量</span><input type="number" min={1} step={1} value={order.quantity} onChange={(event) => update(order.id, { quantity: Number(event.target.value) })} /></label>
        <label><span>释放（分）</span><input type="number" min={0} step="any" value={order.releaseMinute} onChange={(event) => update(order.id, { releaseMinute: Number(event.target.value) })} /></label>
        <label><span>交期（分）</span><input type="number" min={0} step="any" value={order.dueMinute} onChange={(event) => update(order.id, { dueMinute: Number(event.target.value) })} /></label>
        <label><span>优先级</span><input type="number" min={0} max={999} step={1} value={order.priority ?? 0} onChange={(event) => update(order.id, { priority: Number(event.target.value) })} /></label>
        <button type="button" className="order-delete" aria-label={`删除${order.name}`} onClick={() => remove(order.id)}><Trash2 size={13} /></button>
      </article>)}
      {!orders.length ? <p>适合按订单验证有限计划；不配置时继续使用原有连续到料模型。</p> : <small>这是仿真订单计划，不代表已连接 ERP/MES 实际订单。</small>}
    </div>
  </details>;
}

function uniqueOrderId(model: PlantLiteModel): string {
  const ids = new Set((model.productionOrders ?? []).map((order) => order.id));
  for (let index = 1; index <= 10_000; index += 1) if (!ids.has(`order-${index}`)) return `order-${index}`;
  throw new Error("生产订单过多，无法生成唯一 ID");
}
