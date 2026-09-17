//! 全局 Epoch:文档来源、数据、布局、呈现资源集与发布状态的一致性标识。
//! data_revision 不在此维护计数器,由 current_epoch() 同源读取 ChartRuntime。
use super::ChartRuntime;
use crate::deep2d::Deep2dRuntimeContent;
use std::hash::{Hash, Hasher};

/// document_revision 换包/换源即变;layout_revision 仅由窗口物理尺寸变化推进
/// (App::resize 去重后 bump);resource_set 随呈现资源集(legend 页)提交;
/// published 仅在呈现提交成功后为真。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChartEpoch {
    pub document_revision: u64,
    pub data_revision: u64,
    pub layout_revision: u64,
    pub resource_set: u64,
    pub published: bool,
}

impl ChartEpoch {
    pub fn initial() -> Self {
        Self {
            document_revision: 0,
            data_revision: 0,
            layout_revision: 0,
            resource_set: 0,
            published: false,
        }
    }
    pub fn for_document(document_revision: u64) -> Self {
        Self {
            document_revision,
            ..Self::initial()
        }
    }
    /// 内容来源标识:同包两次打开相同,不同包必然不同。DefaultHasher 跨进程不保证
    /// 稳定,仅用于运行期换包对比。
    pub fn document_revision(source_id: &str, source_hash: &str) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (source_id, source_hash).hash(&mut hasher);
        hasher.finish()
    }
    /// 组合当前 epoch:data_revision 直读 chart(同源,禁止复制计数器状态)。
    pub fn current_epoch(&self, chart: Option<&ChartRuntime>) -> Self {
        Self {
            data_revision: chart.map_or(0, ChartRuntime::data_revision),
            ..*self
        }
    }
    pub fn bump_layout(&mut self) -> Result<u64, String> {
        self.layout_revision = self
            .layout_revision
            .checked_add(1)
            .ok_or("chart layout revision exhausted")?;
        Ok(self.layout_revision)
    }
}

/// 候选提交事务:candidate chart + 展示列表 + legend 页打包。可失败步骤(present/stage)
/// 必须在 new 之前完成;commit 在 renderer publish(不可回滚)之后调用,内部纯赋值,
/// 保证 chart/deep2d/epoch 同帧落地,杜绝「GPU 已 publish 而内容未更新」的中间态。
pub struct ChartEpochCommit {
    chart: ChartRuntime,
    deep2d: Deep2dRuntimeContent,
    legend_page: usize,
}

impl ChartEpochCommit {
    pub fn new(chart: ChartRuntime, deep2d: Deep2dRuntimeContent, legend_page: usize) -> Self {
        Self {
            chart,
            deep2d,
            legend_page,
        }
    }
    /// 落地后 chart/deep2d 交由调用方写入活动内容;legend 页一并计入 resource_set。
    pub fn commit(self, epoch: &mut ChartEpoch) -> (ChartRuntime, Deep2dRuntimeContent) {
        epoch.resource_set = self.legend_page as u64;
        epoch.published = true;
        (self.chart, self.deep2d)
    }
}
