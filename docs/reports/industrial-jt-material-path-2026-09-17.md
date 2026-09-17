# JT 材质路径与共享几何

修复 JT 内置导入按数组顺序借用无关材质的问题。材质现在从实例的源装配路径解析，GLB 与属性 sidecar 均记录来源节点；本片对应工业计划 WP-JT 的装配外观 source map。

## 真实输入与结果

复用既有固定 Voyager 语料及使用边界，没有新增模型或依赖。

| 样本 | 实例 | 源材质归属 | 旧规则错配 | 修复后 |
|---|---:|---|---:|---|
| CoffeeMaker JT 9.5 | 64 | 全在祖先节点 | 51 | 64/64 与源路径数值一致 |
| ExampleBlock JT 10.3 | 1 | 叶节点直接附着 | 0 | 1/1 保持一致 |

CoffeeMaker 的共享网格 `…3144` 在 9 条路径为银色，在节点 43 下为灰色。glTF 材质附着在 primitive 上，因此输出由 44 个源网格变为 45 个材质 mesh 容器，64 个节点不变。两个变体的 POSITION、NORMAL、indices accessor 为同一对象，未复制顶点/索引数据。源几何仍为 23,999 顶点、47,962 三角；GLB 通用审计按 mesh 容器计数为 50,194 三角，其中 2,232 是共享几何的再次引用。

材质值相同的不同来源可共享容器，来源仍逐节点记录。没有路径材质时使用既有中性默认并标记 `missing`；多层出现不同材质时标记 `ambiguous`，不猜测当前 reader 尚未保留的完整属性覆盖标志。两种状态都不冒充源材质。既有 diffuse/opacity 到 glTF 的近似 PBR 转换不变，不宣称工程级外观等价。

## 验证

- API JT 七文件 27/27：每个真实实例的源 RGBA、来源路径、共享 accessor、属性/GLB 对齐、无关材质拒绝、歧义与重复源定义、同输入双跑字节确定性、上传→ready→产物读取。
- API typecheck、JT reader 4/4、repository gate 通过。
- 双跑比较改用 `Buffer.equals`，保持逐字节判定。原深对象比较在并行负载下两次超过 5 秒；替换后整组 27 测试耗时 2.86 秒，未放宽超时。

独立本机产物：`test-output/jt-material-path-20260917/`。

| 产物 | SHA-256 |
|---|---|
| CoffeeMaker geometry.glb | `6791ce38cdfb361f938aa1f00845be828ec6c0256dd109bc95cd2182bd2b3e3c` |
| ExampleBlock geometry.glb | `5ec469e2193357ce6e3ac9a02f4467f7341c306c2be4689a03c1fd95334e9825` |

工程检查按 engineering-taste 执行：根因是缺少路径归属，而非颜色数值转换；保留未知覆盖语义并测试同族失败路径。已加载 design-taste-digitaltwin，但本片未过浏览器视觉闭环，未给十维视觉分数；源数值、透明排序、选中外观及两端显示仍需后续视觉验收。没有新增 UI、主题令牌或场景效果，不将产物测试扩大成视觉完成或全部 JT 编码支持。
