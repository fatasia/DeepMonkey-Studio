use super::DataSourcePayload;
use crate::chart::{CHART_DATA_MESSAGE_MAX_BYTES, ChartDataMessage, parse_chart_data_update};

/// 数据负载 → ChartDataMessage 的透传适配:复用 `parse_chart_data_update` 的合同解析,
/// 不解读业务语义;唯一改写是 CAS 对接——以宿主 runtime 当前 data_revision 重写
/// expected/data_revision,使 `ChartRuntime::apply_data_message` 的 CAS 判定成立
/// (源消息自带 revision 仅是传输层记录,跨断线重连后不可信)。
pub fn payload_to_chart_message(
    payload: &DataSourcePayload,
    current_data_revision: u64,
) -> Result<ChartDataMessage, String> {
    if payload.bytes.len() > CHART_DATA_MESSAGE_MAX_BYTES {
        return Err("data source payload exceeds 16 MiB".into());
    }
    let mut message = parse_chart_data_update(&payload.bytes)?;
    message.expected_data_revision = current_data_revision;
    message.data_revision = current_data_revision
        .checked_add(1)
        .filter(|revision| *revision <= 9_007_199_254_740_991)
        .ok_or("chart data revision exhausted")?;
    Ok(message)
}
