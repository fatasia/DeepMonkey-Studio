import { isPagesDemoRuntime } from '../adapters/pagesDemoRuntime';
import { translate as tr, type AppLocale } from '../i18n';
import './PagesDemoNotice.css';

export function PagesDemoNotice({ locale }: { locale: AppLocale }) {
  if (!isPagesDemoRuntime()) return null;
  return <aside className="pages-demo-notice" aria-label={tr(locale, '在线体验说明', 'About this online demo')}>
    <div className="pages-demo-notice-copy">
      <strong>{tr(locale, '浏览器演示 · 无需登录', 'Browser demo · No login needed')}</strong>
      <p>{tr(locale, '从项目工作台打开 SMT 场景，或体验素材、数据与模型优化。编辑保存在当前浏览器。',
        'Open the SMT scene from the project workspace, or explore assets, data and model optimization. Edits stay in this browser.')}</p>
      <p className="pages-demo-account">{tr(locale, '源码开发默认账号：admin / admin。Docker 账号：admin，密码按部署说明获取。',
        'Source development: admin / admin. Docker: admin; follow the deployment guide to retrieve your password.')}</p>
    </div>
    <div className="pages-demo-notice-links">
      <a href="https://github.com/fatasia/DeepMonkey-Studio/releases/tag/v0.2.0" target="_blank" rel="noreferrer">{tr(locale, '下载完整版', 'Download full application')}</a>
      <a href="https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/guides/online-browser.md" target="_blank" rel="noreferrer">{tr(locale, '体验说明', 'Demo guide')}</a>
    </div>
  </aside>;
}
