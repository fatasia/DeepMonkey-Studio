# 部署与系统运维

生产服务使用 PostgreSQL 保存结构化业务数据，MinIO 保存模型、媒体和发布制品。部署脚本不依赖 Docker；本地开发可使用本地文件，也可连接同一套 PostgreSQL 与 MinIO 验证生产路径。

## 本地一键启动

仓库根目录先安装锁定依赖，再根据目标启动：

```powershell
pnpm install --frozen-lockfile
pnpm dev:local          # API + 桌面客户端
pnpm dev:local:web      # API + Web，并打开浏览器
pnpm dev:local:services # 只启动基础服务与 API
pnpm dev:local:check    # 只检查当前依赖和服务，不代启动
```

启动器只会代启本机已安装的 PostgreSQL、MinIO 与本仓库进程；远程地址不可达、端口被其他程序占用或依赖未安装时会直接报告原因。

## 部署生产服务

在服务器安全配置环境变量后先执行预检：

```powershell
pnpm deploy:cloud:check
pnpm deploy:cloud
```

Windows 管理员运行时会注册开机任务并自动重启；没有管理员权限时当前进程仍可启动，但不会承诺开机自启。部署完成后检查系统管理中的服务健康、数据库、对象存储、任务队列和云渲染状态。

## 配置通知与推送

具有管理员权限的用户在“系统管理 → 通知与推送”按顺序配置：

1. 新建 SMTP、飞书、企业微信、钉钉或 Webhook 渠道并执行测试。
2. 新建个人、群组或外部联系人。群机器人只发送到固定群；需要定向个人或部门时使用对应企业应用。
3. 新建规则，选择事件类型、严重度、项目 / 场景 / 对象范围、接收人、渠道和模板。
4. 按需设置静默时段、去重窗口和每小时上限，再查看投递审计中的成功、抑制、失败与重试次数。

凭据只由服务端保存为密钥引用，页面不会回显完整密钥。测试消息成功不等于业务规则生效，还需触发目标事件并核对投递审计。

## 备份、恢复与密钥轮换

一致性备份前先停止 API：

```powershell
pnpm deploy:cloud:stop
pnpm backup:production
pnpm verify:restore -- --input <备份目录>
```

恢复操作要求显式传入备份清单中的 ID，避免选错目标；具体参数以脚本输出为准。恢复完成后先验证 PostgreSQL 记录数、MinIO 对象清单和哈希，再启动服务。密钥轮换使用 `pnpm rotate:secrets`，轮换后必须重新登录并测试外部渠道。

## 日常故障定位

先查看系统管理的健康状态和操作审计，再沿“存储 → API → Web / 客户端 → 数据连接 → 任务”定位。弱网重试有退避和上限；连续失败时不要频繁手工刷新，以免放大现场连接压力。

发布运行问题按[交付自检与故障恢复](/docs/troubleshooting)处理；运行方式、开源组件与商业适配器边界见[选择运行方式与扩展能力](/docs/runtime-and-extensions)。
