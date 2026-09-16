//! 按 series 类型拒绝不适用字段，包括值为 null 的字段。
use super::types::{ChartSeries, ChartSeriesType};
use serde::{Deserialize, Deserializer};

#[derive(Deserialize)]
#[serde(remote = "ChartSeries", rename_all = "camelCase", deny_unknown_fields)]
struct Fields {
    id: String,
    label: String,
    #[serde(rename = "type")]
    series_type: ChartSeriesType,
    dataset_id: String,
    x: Option<String>,
    y: Option<String>,
    name: Option<String>,
    value: Option<String>,
    min: Option<f64>,
    max: Option<f64>,
    x_axis_id: Option<String>,
    y_axis_id: Option<String>,
}

impl<'de> Deserialize<'de> for ChartSeries {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("Expected chart series object"))?;
        let fields = match object.get("type").and_then(|value| value.as_str()) {
            Some("pie") => &["name", "value"][..],
            Some("gauge") => &["name", "value", "min", "max"][..],
            Some("heatmap") => &["x", "y", "value", "xAxisId", "yAxisId"][..],
            Some("line" | "bar" | "scatter") => &["x", "y", "xAxisId", "yAxisId"][..],
            _ => return Err(serde::de::Error::custom("Unsupported chart series type")),
        };
        for key in object.keys() {
            if !["id", "label", "type", "datasetId"].contains(&key.as_str())
                && !fields.contains(&key.as_str())
            {
                return Err(serde::de::Error::custom(format!(
                    "Field {key} is not defined for this series type"
                )));
            }
        }
        for field in fields {
            if object.get(*field).is_none_or(|value| value.is_null()) {
                return Err(serde::de::Error::custom(format!(
                    "Series field {field} is required"
                )));
            }
        }
        Fields::deserialize(value).map_err(serde::de::Error::custom)
    }
}
