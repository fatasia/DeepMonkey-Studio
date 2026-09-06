import { useLayoutEffect, useRef, useState } from "react";
import { RosbridgeConnection, type RosConnectionOptions, type RosConnectionState } from "../robots/RosbridgeConnection";
import type { JointValues } from "../robots/rosbridgeJointState";

export interface RobotConnectionBindings { modelId: string; owner?: object; jointNames: readonly string[]; disabled?: boolean; onTelemetry(values: JointValues): void; onRestorePose(): void }
export function useRobotConnection(props: RobotConnectionBindings, following = true) {
  const [state, setState] = useState<RosConnectionState>({ status: "idle" });
  const sessionRef = useRef<{ connection: RosbridgeConnection; restore: () => boolean; restorePose: () => void } | undefined>(undefined);
  const callbacksRef = useRef(props); callbacksRef.current = props;
  const followRef = useRef(following); followRef.current = following;
  const signature = JSON.stringify(props.jointNames);
  const disconnect = () => {
    const session = sessionRef.current; sessionRef.current = undefined;
    if (!session) return;
    session.connection.disconnect(false); setState(session.restore() ? { status: "disconnected" } : { status: "error", issue: "telemetry-apply" });
  };
  useLayoutEffect(() => { disconnect(); }, [props.modelId, props.owner, signature, props.disabled]);
  useLayoutEffect(() => {
    if (following || !sessionRef.current) return;
    try { sessionRef.current.restorePose(); }
    catch { disconnect(); setState({ status: "error", issue: "telemetry-apply" }); }
  }, [following]);
  useLayoutEffect(() => () => {
    const session = sessionRef.current; sessionRef.current = undefined;
    session?.connection.disconnect(false); session?.restore();
  }, []);
  const connect = (options: Omit<RosConnectionOptions, "jointNames">) => {
    disconnect();
    if (props.disabled) return;
    // 恢复回调绑定创建会话时的模型，不能在切换对象后恢复新实例。
    const restore = props.onRestorePose;
    let restored = false;
    let restoreSucceeded = true;
    const restoreOnce = () => { if (!restored) { restored = true; try { restore(); } catch { restoreSucceeded = false; } } return restoreSucceeded; };
    const owned = () => {
      const current = callbacksRef.current;
      return sessionRef.current?.connection === connection && current.modelId === props.modelId && current.owner === props.owner && JSON.stringify(current.jointNames) === signature && !current.disabled;
    };
    const connection = new RosbridgeConnection({ ...options, jointNames: [...props.jointNames] }, {
      onTelemetry: values => {
        if (owned() && followRef.current) callbacksRef.current.onTelemetry(values);
      },
      onState: next => {
        if (!owned()) return;
        setState(next);
        if ((next.status === "error" || next.status === "disconnected") && !restoreOnce()) setState({ status: "error", issue: "telemetry-apply" });
      },
    });
    sessionRef.current = { connection, restore: restoreOnce, restorePose: restore };
    connection.connect();
  };
  return { state, connect, disconnect, connection: () => sessionRef.current?.connection };
}
