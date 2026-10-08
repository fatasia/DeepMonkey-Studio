import { isPagesDemoRuntime } from '../adapters/pagesDemoRuntime';
import { translate as tr, type AppLocale } from '../i18n';
import './PagesDemoNotice.css';

export function PagesDemoNotice({ locale }: { locale: AppLocale }) {
  if (!isPagesDemoRuntime()) return null;
  return <aside className="pages-demo-notice" aria-label={tr(locale, '在线体验说明', 'About this online demo')}>
    <div className="pages-demo-notice-copy">
      <strong>{tr(locale, '浏览器演示 · 无需登录', 'Browser demo · No login needed')}</strong>
      <p>{tr(locale, '体验 SMT 场景、素材库、数据管线、本体图谱和演示助手。示例数据在浏览器本地运行，编辑自动保存在当前浏览器。',
        'Explore the SMT scene, assets, data pipelines, ontology graph and demo assistant. Sample data runs locally; edits stay in this browser.')}</p>
      <p className="pages-demo-account">{tr(locale, '源码开发默认账号：admin / admin。Docker 账号：admin，密码按部署说明获取。',
        'Source development: admin / admin. Docker: admin; follow the deployment guide to retrieve your password.')}</p>
    </div>
    <div className="pages-demo-notice-links">
      <a href="https://github.com/fatasia/DeepMonkey-Studio/releases/tag/v0.2.0" target="_blank" rel="noreferrer">{tr(locale, '下载完整版', 'Download full application')}</a>
      <a href="https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/guides/online-browser.md" target="_blank" rel="noreferrer">{tr(locale, '体验说明', 'Demo guide')}</a>
    </div>
  </aside>;
}
