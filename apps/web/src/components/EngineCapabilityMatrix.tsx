import { useMemo } from "react";
import { ShieldCheck } from "lucide-react";
import { buildEngineCapabilityMatrix, type CapabilityMatrixDomain, type CapabilityTone } from "../engineCapabilityMatrixModel";
import "./EngineCapabilityMatrix.css";

/**
 * 六引擎对标 P2:公开引擎能力矩阵页(文档中心「渲染引擎」分类内嵌活动组件)。
 *
 * 数据单源 = contracts 两张登记表(rendererCapabilityManifest + modelFormatCatalog),
 * 运行时派生、零手抄(engineCapabilityMatrixModel.ts);文档 markdown 只承担导语,
 * 全部状态/证据由本组件在每次渲染时从登记表现算,登记表改了页面即变。
 *
 * 诚实条款:物理域当前没有公开登记表,本页给"未登记"空态,不虚构行;
 * 证据列展示登记表 evidence 原文(仓库路径:符号),可追溯而非营销文案。
 */

const TONE_CLASS: Readonly<Record<CapabilityTone, string>> = {
  ok: "ok",
  optin: "optin",
  neutral: "neutral",
  warn: "warn",
  planned: "planned",
  blocked: "blocked",
};

const TONE_LABEL: Readonly<Record<CapabilityTone, string>> = {
  ok: "完整可用",
  optin: "需开启",
  neutral: "限定",
  warn: "受限",
  planned: "规划中",
  blocked: "不可用",
};

export function EngineCapabilityMatrix() {
  const matrix = useMemo(() => buildEngineCapabilityMatrix(), []);
  const { renderer, formats } = matrix;

  return (
    <div className="engine-capability-matrix">
      <p className="capm-note">
        本页由内置能力登记表在运行时生成:渲染能力行 = 双端协商登记表(Studio/Web 与 Native/Rust 逐行对状态),
        格式支持行 = 模型格式能力目录;每行携带登记表中的文件证据,状态变化随登记表即时生效。
      </p>
      <div className="capm-legend" aria-label="状态图例">
        <span className="capm-legend-title">状态图例</span>
        {Object.entries(TONE_LABEL).map(([tone, label]) => (
          <span key={tone} className="capm-legend-item">
            <span className={`capm-pill ${TONE_CLASS[tone as CapabilityTone]}`}>{label}</span>
          </span>
        ))}
      </div>

      <section className="capm-section" aria-label="渲染能力">
        <header className="capm-section-head">
          <h3>渲染引擎能力</h3>
          <span className="capm-chips">
            <span className="capm-chip ok">双端完整 {renderer.counts.bothSupported}/{renderer.counts.total}</span>
            <span className="capm-chip warn">受限 {renderer.counts.limited}</span>
            <span className="capm-chip planned">规划中 {renderer.counts.planned}</span>
          </span>
        </header>
        {renderer.domains.length === 0 ? (
          <p className="capm-empty">登记表为空——没有可公开的能力行。</p>
        ) : (
          renderer.domains.map(domain => <DomainTable key={domain.id} domain={domain} />)
        )}
      </section>

      <section className="capm-section" aria-label="格式支持">
        <header className="capm-section-head">
          <h3>格式支持</h3>
          <span className="capm-chips">
            <span className="capm-chip ok">生产可用 {formats.productionReady}/{formats.rows.length}</span>
          </span>
        </header>
        {formats.rows.length === 0 ? (
          <p className="capm-empty">格式能力目录为空。</p>
        ) : (
          <div className="capm-table-scroll">
            <table className="capm-table">
              <thead>
                <tr>
                  <th scope="col">格式</th>
                  <th scope="col">扩展名</th>
                  <th scope="col">方向</th>
                  <th scope="col">范围</th>
                  <th scope="col">状态</th>
                  <th scope="col">证据</th>
                </tr>
              </thead>
              <tbody>
                {formats.rows.map(row => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.label}</strong>
                      <small title={row.decisionReason}>{row.decisionReason}</small>
                    </td>
                    <td><code>{row.extensions.join(" · ")}</code></td>
                    <td>{row.directionLabel}</td>
                    <td>{row.scopeLabel}</td>
                    <td><span className={`capm-pill ${TONE_CLASS[row.tone]}`}>{row.statusLabel}</span></td>
                    <td>
                      {row.evidenceRefs.length === 0
                        ? <span className="capm-evidence-empty">暂无证据记录</span>
                        : <ul className="capm-evidence-list">
                            {row.evidenceRefs.map(ref => <li key={ref}><code title={ref}>{ref}</code></li>)}
                          </ul>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="capm-section" aria-label="物理能力">
        <header className="capm-section-head">
          <h3>物理能力</h3>
        </header>
        <p className="capm-empty">
          物理能力尚未建立双端公开登记表(缺少逐行文件证据的单源),按诚实条款本页不虚构行;
          物理现状见「物理系统」面板与引擎文档,登记表建立后此处自动展开。
        </p>
      </section>

      <footer className="capm-footnote">
        <ShieldCheck size={13} />
        <span>
          登记纪律:任一端落地新能力必须同步登记双端状态与文件证据,单端登记会被对拍测试判红;
          本页状态词汇(supported / degraded / unavailable 与原因码)与协商合同逐词一致。
        </span>
      </footer>
    </div>
  );
}

function DomainTable({ domain }: { domain: CapabilityMatrixDomain }) {
  return (
    <div className="capm-domain">
      <h4>{domain.title}<small>{domain.rows.length} 项</small></h4>
      <div className="capm-table-scroll">
        <table className="capm-table">
          <thead>
            <tr>
              <th scope="col">能力</th>
              <th scope="col">Studio(Web)</th>
              <th scope="col">Native(Rust)</th>
              <th scope="col">证据</th>
            </tr>
          </thead>
          <tbody>
            {domain.rows.map(row => (
              <tr key={row.id}>
                <td>
                  <strong title={row.id}>{row.title}</strong>
                  <small>{row.id}</small>
                </td>
                <EndCell cell={row.web} />
                <EndCell cell={row.native} />
                <td className="capm-evidence-cell">
                  <code title={row.web.evidence}>{row.web.evidencePath}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EndCell({ cell }: { cell: CapabilityMatrixDomain["rows"][number]["web"] }) {
  return (
    <td>
      <span className={`capm-pill ${TONE_CLASS[cell.tone]}`} title={`support=${cell.support} · reason=${cell.reason}`}>
        {cell.label}
      </span>
    </td>
  );
}
