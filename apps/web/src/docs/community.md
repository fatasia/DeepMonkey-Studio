# 社区、支持与项目治理

Deep Monkey Studio 通过 Issue 讨论问题，通过 Pull Request 审查改动。完整政策保存在源码仓库；这里帮助使用者选择正确入口。

## 报告问题或提出建议

可复现缺陷使用[Bug report](https://github.com/fatasia/bim-studio/issues/new?template=bug_report.yml)，文档错误使用[Documentation](https://github.com/fatasia/bim-studio/issues/new?template=documentation.yml)，新能力使用[Feature request](https://github.com/fatasia/bim-studio/issues/new?template=feature_request.yml)。

报告写清版本或提交号、操作系统、浏览器、运行方式、复现步骤、预期与实际结果。渲染问题补充 GPU 与后端，模型问题补充格式与导出器，数据问题补充失败阶段。先按[故障恢复](/docs/troubleshooting)缩小范围。

安装和使用疑问按仓库[支持指南](https://github.com/fatasia/bim-studio/blob/HEAD/SUPPORT.md)处理。社区答复取决于维护者时间；已收录的建议不代表排期。

## 私下报告安全问题

疑似漏洞、凭据泄露和敏感复现应使用[私密漏洞报告](https://github.com/fatasia/bim-studio/security/advisories/new)，不要贴到公开 Issue。该入口不可用时按[安全政策](https://github.com/fatasia/bim-studio/blob/HEAD/SECURITY.md)联系仓库所有者。

公开报告和截图需要移除密码、令牌、私人地址、个人数据与客户模型。复现样本保留触发问题所需的最少内容。

## 决策与维护

贡献者提交改动，审查者提供技术意见，维护者负责合并与发布，项目负责人决定方向和根本政策。大型变更需要设计记录，争议需保留证据与最终决定。

默认分支按治理要求使用保护规则，合并需要维护者审查和必需检查。维护者身份与职责见[维护者说明](https://github.com/fatasia/bim-studio/blob/HEAD/MAINTAINERS.md)，详细决策方式见[治理规则](https://github.com/fatasia/bim-studio/blob/HEAD/GOVERNANCE.md)。

## 版本与路线图

发行版本采用语义化版本号。1.0 之前的次版本可能包含已说明的兼容变化；升级前阅读变更日志、迁移要求和恢复步骤。产品文档版本 `2026.09` 是内容版本，不表示已经发布同名安装包。

当前重点与范围见[路线图](https://github.com/fatasia/bim-studio/blob/HEAD/ROADMAP.md)，实际交付以[变更日志](https://github.com/fatasia/bim-studio/blob/HEAD/CHANGELOG.md)和发行说明为准。

## 使用许可与署名

本项目采用 Deep Monkey Community Source License 1.0，对外称为公开源码或 source-available。具体使用权以仓库[LICENSE](https://github.com/fatasia/bim-studio/blob/HEAD/LICENSE)为准，第三方依赖继续遵循各自许可证。

重新分发前阅读[许可说明](https://github.com/fatasia/bim-studio/blob/HEAD/LICENSING.md)和[第三方声明](https://github.com/fatasia/bim-studio/blob/HEAD/THIRD_PARTY_NOTICES.md)。贡献流程见[开发与贡献](/docs/contributing)。
