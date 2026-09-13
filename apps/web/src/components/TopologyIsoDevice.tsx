import type { TopologyNode } from "@bim-studio/contracts";

/** 共享轴向的轻量设备图元，不依赖外部模型或 WebGL 上下文。 */
export function TopologyIsoDevice({ node }: { node: TopologyNode }) {
  const tank = ["tank", "boiler"].includes(node.kind);
  const rotating = ["pump", "motor", "fan", "compressor"].includes(node.kind);
  const logistics = ["agv", "conveyor", "workstation", "warehouse"].includes(node.kind);
  return <svg className="topology-iso-device" viewBox="0 0 164 104" aria-hidden="true">
    <path className="topology-iso-device__footprint" d="M 12 60 L 82 20 L 152 60 L 82 100 Z" />
    <path className="topology-iso-device__base" d="M 22 61 L 82 27 L 142 61 L 82 95 Z" />
    {node.kind === "valve" ? <>
      <path className="topology-iso-device__front" d="M 43 44 L 78 63 L 43 74 Z M 119 44 L 84 63 L 119 74 Z" />
      <path className="topology-iso-device__top" d="M 43 44 L 56 36 L 82 53 L 107 36 L 119 44 L 84 65 L 78 65 Z" />
      <path className="topology-iso-device__detail" d="M 81 58 L 81 25" />
      <ellipse className="topology-iso-device__signal" cx="81" cy="24" rx="17" ry="8" />
    </> : node.kind === "meter" || node.kind === "sensor" ? <>
      <path className="topology-iso-device__side" d="M 70 67 L 90 56 L 90 82 L 70 93 Z" />
      <ellipse className="topology-iso-device__front" cx="80" cy="44" rx="25" ry="30" />
      <ellipse className="topology-iso-device__top" cx="80" cy="44" rx="18" ry="23" />
      <path className="topology-iso-device__signal" d="M 80 44 L 91 30" />
      <path className="topology-iso-device__detail" d="M 68 35 L 71 37 M 80 24 L 80 29 M 92 44 L 97 44" />
    </> : tank ? <>
      <path className="topology-iso-device__front" d="M 52 24 A 30 15 0 0 0 112 24 L 112 65 A 30 15 0 0 1 52 65 Z" />
      <ellipse className="topology-iso-device__top" cx="82" cy="24" rx="30" ry="15" />
      <path className="topology-iso-device__detail" d="M 60 44 Q 82 55 104 44 M 60 55 Q 82 66 104 55" />
      <path className="topology-iso-device__signal" d="M 112 61 L 138 76" />
    </> : rotating ? <>
      <path className="topology-iso-device__side" d="M 53 40 L 86 21 Q 110 17 115 42 L 82 62 Z" />
      <ellipse className="topology-iso-device__front" cx="67" cy="52" rx="22" ry="26" transform="rotate(-30 67 52)" />
      <ellipse className="topology-iso-device__top" cx="67" cy="52" rx="10" ry="13" transform="rotate(-30 67 52)" />
      <path className="topology-iso-device__detail" d="M 89 30 L 102 47 M 97 26 L 110 43" />
      <path className="topology-iso-device__signal" d="M 84 64 L 112 80 L 139 64" />
    </> : <>
      <path className="topology-iso-device__front" d={`M 42 ${logistics ? 48 : 27} L 82 ${logistics ? 71 : 50} L 82 83 L 42 60 Z`} />
      <path className="topology-iso-device__side" d={`M 82 ${logistics ? 71 : 50} L 122 ${logistics ? 48 : 27} L 122 60 L 82 83 Z`} />
      <path className="topology-iso-device__top" d={`M 42 ${logistics ? 48 : 27} L 82 ${logistics ? 25 : 4} L 122 ${logistics ? 48 : 27} L 82 ${logistics ? 71 : 50} Z`} />
      {!logistics && <path className="topology-iso-device__detail" d="M 48 39 L 75 55 M 48 47 L 75 63 M 48 55 L 75 71" />}
      <path className="topology-iso-device__signal" d="M 89 65 L 112 52" />
    </>}
    <circle className="topology-iso-device__port" cx="4" cy="60" r="3" />
    <circle className="topology-iso-device__port" cx="160" cy="60" r="3" />
  </svg>;
}
