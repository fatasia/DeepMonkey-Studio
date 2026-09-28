# WorkshopKit.LICENSE.md — T00 多资产车间基准派生资产

来源:Kenney Factory Kit 3.0(https://kenney.nl/assets/factory-kit),许可 CC0-1.0。
仓内源压缩包 `data/external-assets/open-packs/factory.zip`,SHA-256
`7e31fb2308e90304672bd15cd18fa9d9f02c03731a8cbc57a8e3e1c181dfb0a7`;派生算法与 `FactoryMachine.glb`(prepareT00S1Factory.mjs)相同:
仅将共享 `Textures/colormap.png`(SHA-256 `35d7bd6900dde0208429eeaec87fa17fbf024ed59f3f4eab54bc92802eba9dd7`)内嵌进 GLB buffer,
不改网格、材质、节点与单位。下列派生 GLB 的 SHA-256 由
`packages/deep-engine/lab/factoryWorkshop.ts` 在浏览器侧复核,由本脚本
`prepareT00Workshop.mjs` 确定性再生。

- `WorkshopConveyor.glb`(源 `conveyor.glb`,196 三角形,1 图元,1 mesh,1 mesh 节点)SHA-256 `c0e7614b3e548f795414851c8ed4cf892e7b2b4a353ca3c6b36c07232009d9d7`
- `WorkshopCrate.glb`(源 `box-large.glb`,70 三角形,1 图元,1 mesh,1 mesh 节点)SHA-256 `b19c4832b395b3bc5a2bd4ee0ef5c0662c3ae4d4608859fa0161e63f2ce5c544`
- `WorkshopHopper.glb`(源 `hopper-square.glb`,104 三角形,1 图元,1 mesh,1 mesh 节点)SHA-256 `aaa5116ebcc0fdeabbbcb34967a39dfd8bfec82769ca7fe9e5307c9396806dd3`
- `WorkshopColumn.glb`(源 `structure-high.glb`,268 三角形,1 图元,1 mesh,1 mesh 节点)SHA-256 `d3239c145bd427938beb38eef369e56cb22c62328d660e208da909c34afd00d1`
- `WorkshopCatwalk.glb`(源 `catwalk-straight.glb`,328 三角形,1 图元,1 mesh,1 mesh 节点)SHA-256 `1985dee1f58295bb98e605e6af71656a268803eba3e1d7e3f9add13850b3c9e3`
- `WorkshopRobotArm.glb`(源 `robot-arm-a.glb`,472 三角形,9 图元,9 mesh,9 mesh 节点)SHA-256 `67b6f2be98bb3933c1ea9afce9bdb10db77dd6931f77cc1d6c20d948f9f34189`
- `WorkshopScreen.glb`(源 `screen-flat.glb`,120 三角形,1 图元,1 mesh,1 mesh 节点)SHA-256 `40483ac0e377a4c78e30c5e0d56226e39414b2fc33b58c4a60568ed26c8985cb`
