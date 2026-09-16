# Dashboard 资源准备基础

本切片将资源计划、预算、去重与生命周期从三维 bake 策略中分离，供 v5 Dashboard 和既有三维准备流程共用。Dashboard 不再因空 render placeholder 触发几何 bake。

`resourcePrewarmTypes/Plan/Executor` 只依赖已提交的包合同。计划冻结后按内容身份加载和准备资源，失败、取消和迟到候选释放自身资源，保留活动版本。同步 commit 回调禁止重入 publish/dispose，避免释放仍被候选复用的句柄；回调异常后可继续发布。

独立 HEAD 加七文件通过运行包 224 项测试及核心/Lab 类型检查。工作树原 prewarm 三文件改为薄包装，共用相同 executor；兼容树 302 项测试和双类型通过。九类旧 golden × 三档质量的原计划及 hash 保持一致，v5 移除几何 bake 是预期差异。原三文件仍属于待审查的三维依赖闭包，不混入本次独立提交。

这只完成资源准备基础。资源排序不保证组合依赖已全部就绪，同步资源 commit 也不代表画面成功 present。浏览器组合候选、ChartIR 绘制宿主、整页 present/LKG 和实际双图表验证仍是 C1 待办。
