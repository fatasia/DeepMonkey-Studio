//! 触控指针统一:把 winit 触控事件映射为与鼠标左键一致的按下/移动/抬起语义。
//!
//! 鼠标链(`CursorMoved`/`MouseInput`)与触控链(`WindowEvent::Touch`)共用同一批
//! 处理函数,保证点击、文本聚焦、拖动选区在鼠标与触屏两种输入下语义一致。
//! 本模块只负责"触控→指针动作"的纯映射决策,便于脱离窗口状态单测。

use winit::event::TouchPhase;

/// 触控映射出的指针动作;与鼠标左键事件一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TouchPointerAction {
    /// 等价鼠标左键按下:点击、文本聚焦与图表命中的起点。
    Press,
    /// 等价鼠标移动:悬停推进与拖动选区。
    Move,
    /// 等价鼠标左键抬起:确认与提交。
    Release,
    /// 系统取消手势(如手势被滚动手势劫持):语义为抬起但不产生点击。
    Cancel,
}

/// 单指触点跟踪器:只跟踪首个触点,后续触点整体忽略。
/// 这保证多点触控不会向鼠标语义链注入互相矛盾的移动序列。
#[derive(Default)]
pub(super) struct TouchPointerTracker {
    active: Option<u64>,
}

impl TouchPointerTracker {
    pub(super) fn new() -> Self {
        Self::default()
    }

    /// 输入一条触控事件,返回应按鼠标语义处理的动作与物理坐标。
    /// 返回 `None` 表示该触点不属于当前手势(第二触点/非主触点的乱序事件),
    /// 调用方应整体忽略,不得推进任何指针状态。
    pub(super) fn on_touch(
        &mut self,
        id: u64,
        phase: TouchPhase,
        location: [f64; 2],
    ) -> Option<(TouchPointerAction, [f64; 2])> {
        match phase {
            TouchPhase::Started => {
                // 已有主触点时,第二指按下不改变指针语义(避免误触发点击)。
                if self.active.is_some() {
                    return None;
                }
                self.active = Some(id);
                Some((TouchPointerAction::Press, location))
            }
            TouchPhase::Moved => {
                if self.active == Some(id) {
                    Some((TouchPointerAction::Move, location))
                } else {
                    None
                }
            }
            TouchPhase::Ended => {
                // 先比对再释放:非主触点的结束事件不得误清主触点。
                if self.active == Some(id) {
                    self.active = None;
                    Some((TouchPointerAction::Release, location))
                } else {
                    None
                }
            }
            TouchPhase::Cancelled => {
                if self.active == Some(id) {
                    self.active = None;
                    Some((TouchPointerAction::Cancel, location))
                } else {
                    None
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 单指完整手势映射为按下移动抬起() {
        let mut tracker = TouchPointerTracker::new();
        assert_eq!(
            tracker.on_touch(7, TouchPhase::Started, [10.0, 20.0]),
            Some((TouchPointerAction::Press, [10.0, 20.0]))
        );
        assert_eq!(
            tracker.on_touch(7, TouchPhase::Moved, [30.0, 40.0]),
            Some((TouchPointerAction::Move, [30.0, 40.0]))
        );
        assert_eq!(
            tracker.on_touch(7, TouchPhase::Ended, [30.0, 40.0]),
            Some((TouchPointerAction::Release, [30.0, 40.0]))
        );
        // 抬起后跟踪器回到空闲,新的一次触控重新从按下开始
        assert_eq!(
            tracker.on_touch(9, TouchPhase::Started, [1.0, 2.0]),
            Some((TouchPointerAction::Press, [1.0, 2.0]))
        );
    }

    #[test]
    fn 第二触点与非主触点事件被整体忽略() {
        let mut tracker = TouchPointerTracker::new();
        assert_eq!(
            tracker.on_touch(1, TouchPhase::Started, [0.0, 0.0]),
            Some((TouchPointerAction::Press, [0.0, 0.0]))
        );
        // 第二指按下/移动/抬起都不推进指针语义
        assert_eq!(tracker.on_touch(2, TouchPhase::Started, [5.0, 5.0]), None);
        assert_eq!(tracker.on_touch(2, TouchPhase::Moved, [6.0, 6.0]), None);
        assert_eq!(tracker.on_touch(2, TouchPhase::Ended, [6.0, 6.0]), None);
        // 主触点仍受控
        assert_eq!(
            tracker.on_touch(1, TouchPhase::Moved, [3.0, 4.0]),
            Some((TouchPointerAction::Move, [3.0, 4.0]))
        );
    }

    #[test]
    fn 取消释放主触点且等价抬起但不点击() {
        let mut tracker = TouchPointerTracker::new();
        tracker.on_touch(1, TouchPhase::Started, [0.0, 0.0]);
        assert_eq!(
            tracker.on_touch(1, TouchPhase::Cancelled, [0.0, 0.0]),
            Some((TouchPointerAction::Cancel, [0.0, 0.0]))
        );
        // 取消后跟踪器空闲;迟到的主触点 Ended 事件被忽略(已不持有该触点)
        assert_eq!(tracker.on_touch(1, TouchPhase::Ended, [0.0, 0.0]), None);
        assert_eq!(
            tracker.on_touch(3, TouchPhase::Started, [8.0, 8.0]),
            Some((TouchPointerAction::Press, [8.0, 8.0]))
        );
    }

    #[test]
    fn 乱序结束事件不激活跟踪器() {
        let mut tracker = TouchPointerTracker::new();
        // 未按下的移动/抬起不得凭空产生手势
        assert_eq!(tracker.on_touch(1, TouchPhase::Moved, [1.0, 1.0]), None);
        assert_eq!(tracker.on_touch(1, TouchPhase::Ended, [1.0, 1.0]), None);
        assert_eq!(tracker.on_touch(1, TouchPhase::Cancelled, [1.0, 1.0]), None);
        // 状态仍未被污染
        assert_eq!(
            tracker.on_touch(1, TouchPhase::Started, [2.0, 2.0]),
            Some((TouchPointerAction::Press, [2.0, 2.0]))
        );
    }
}
