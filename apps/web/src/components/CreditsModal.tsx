import { ExternalLink, HeartHandshake, X } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

const projects = [
  ["Three.js", "MIT", "https://github.com/mrdoob/three.js"],
  ["That Open Components", "MIT", "https://github.com/ThatOpen/engine_components"],
  ["That Open Fragments", "MIT", "https://github.com/ThatOpen/engine_fragment"],
  ["web-ifc", "MPL-2.0", "https://github.com/ThatOpen/engine_web-ifc"],
  ["glTF Transform", "Apache-2.0", "https://github.com/donmccurdy/glTF-Transform"],
  ["Draco", "Apache-2.0", "https://github.com/google/draco"],
  ["meshoptimizer", "MIT", "https://github.com/zeux/meshoptimizer"],
  ["three-mesh-bvh", "MIT", "https://github.com/gkjohnson/three-mesh-bvh"],
  ["dxf-parser", "MIT", "https://github.com/gdsestimating/dxf-parser"],
  ["OCCT Import JS", "LGPL-2.1", "https://github.com/kovacsv/occt-import-js"],
  ["Node-RED", "Apache-2.0", "https://github.com/node-red/node-red"],
  ["FlowFuse Dashboard", "Apache-2.0", "https://github.com/FlowFuse/node-red-dashboard"],
  ["TDengine Node.js Connector", "MIT", "https://github.com/taosdata/taos-connector-node"],
  ["React", "MIT", "https://github.com/facebook/react"],
  ["Lucide", "ISC", "https://github.com/lucide-icons/lucide"]
] as const;

export function CreditsModal({ locale, onClose }: { locale: AppLocale; onClose: () => void }) {
  return <div className="modal-backdrop credits-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="credits-modal" role="dialog" aria-modal="true" aria-label={tr(locale, "开源项目致谢", "Open-source acknowledgements")}>
      <header><span><HeartHandshake size={18} /></span><div><strong>{tr(locale, "开源项目致谢", "Open-source acknowledgements")}</strong><small>{tr(locale, "感谢这些项目让 BIM Studio 成为可能", "Thanks to the projects that make BIM Studio possible")}</small></div><button title={tr(locale, "关闭", "Close")} onClick={onClose}><X size={16} /></button></header>
      <div className="credits-list">{projects.map(([name, license, url]) => <a key={name} href={url} target="_blank" rel="noreferrer"><span><strong>{name}</strong><small>{license}</small></span><ExternalLink size={14} /></a>)}</div>
      <footer>{tr(locale, "完整版本与许可证清单见 THIRD_PARTY_NOTICES.md；发布前应按锁文件重新生成依赖审计。", "See THIRD_PARTY_NOTICES.md for exact versions and license notes; regenerate the dependency audit before release.")}</footer>
    </section>
  </div>;
}
