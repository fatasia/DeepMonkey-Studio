import { renderToStaticMarkup } from "react-dom/server";
import { describe,expect,it } from "vitest";
import { resolveDeviceSignal } from "@bim-studio/contracts";
import { DeviceSignalView } from "./DeviceSignalView";
describe("shared device signal view",()=>{
  it("renders state with symbol, semantic token and label without a false healthy class",()=>{
    const html=renderToStaticMarkup(<DeviceSignalView locale="zh-CN" title="循环泵" signal={resolveDeviceSignal("offline")} />);
    expect(html).toContain("离线");expect(html).toContain("⊘");expect(html).toContain("var(--info)");expect(html).not.toContain('class="ok"');
  });
  it("shows acknowledgment from the owner and exposes actions only when wired",()=>{
    const signal=resolveDeviceSignal({state:"alarm",alarm:{active:true,acknowledged:true,message:"压力高",severity:"critical"}});
    const html=renderToStaticMarkup(<DeviceSignalView locale="zh-CN" title="循环泵" signal={signal} onAcknowledge={()=>{}} onLocate={()=>{}} />);
    expect(html).toContain("已确认");expect(html).toContain("定位设备");expect(html).not.toContain(">确认告警</button>");
    expect(renderToStaticMarkup(<DeviceSignalView locale="en-US" title="Pump" signal={resolveDeviceSignal("alarm")} />)).toContain("Unacknowledged");
  });
});
