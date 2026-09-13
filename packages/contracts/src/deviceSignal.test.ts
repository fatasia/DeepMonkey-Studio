import { describe,expect,it } from "vitest";
import { assertDeviceSignalRule,resolveDeviceSignal } from "./deviceSignal.js";
describe("shared device signal semantics",()=>{
  it("does not classify nonempty false/offline/fault strings as healthy",()=>{
    expect(resolveDeviceSignal("false").state).toBe("idle");
    expect(resolveDeviceSignal("offline").state).toBe("offline");
    expect(resolveDeviceSignal("fault")).toMatchObject({state:"alarm",active:true,severity:"critical"});
    for(const value of [undefined,null,"",NaN,Infinity,{},"unrecognised"])expect(resolveDeviceSignal(value).state).toBe("unknown");
    expect(resolveDeviceSignal(0).state).toBe("normal");
  });
  it("uses inclusive finite thresholds and distinguishes confirmation from clearing",()=>{
    expect(resolveDeviceSignal(6,{highAlarm:6,severity:"critical"})).toMatchObject({state:"alarm",active:true,acknowledged:false});
    expect(resolveDeviceSignal(6,{highAlarm:6,severity:"warning"})).toMatchObject({state:"warning",active:true});
    expect(resolveDeviceSignal({state:"alarm",alarm:{id:"a",severity:"critical",active:true,acknowledged:true}})).toMatchObject({active:true,acknowledged:true,alarmId:"a"});
    expect(resolveDeviceSignal({state:"alarm",alarm:{active:false,acknowledged:true}})).toMatchObject({state:"normal",active:false,acknowledged:false});
    expect(resolveDeviceSignal({state:"offline",value:8},{highAlarm:6})).toMatchObject({state:"offline",active:false});
    expect(resolveDeviceSignal({state:"offline",alarm:{active:true,severity:"critical"}})).toMatchObject({state:"offline",active:true});
  });
  it("rejects ambiguous and invalid rule configuration",()=>{
    for(const rule of [{lowAlarm:6,highAlarm:6},{lowAlarm:7,highAlarm:6},{highAlarm:NaN},{severity:"severe"},null])expect(()=>assertDeviceSignalRule(rule)).toThrow();
  });
});
