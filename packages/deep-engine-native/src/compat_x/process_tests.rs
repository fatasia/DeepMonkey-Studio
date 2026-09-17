use super::*;

fn envelope() -> Envelope {
    Envelope {
        version: 1,
        budget: XBudget::default(),
        request: XRequest {
            schema_version: 1,
            expected_epoch: 7,
            started_at_ms: 10,
            random_seed: 1,
            resources: vec![],
            events: vec![],
            calls: vec![XCall::EmitNumber(-0.0)],
        },
        context: XExecutionContext {
            current_epoch: 7,
            now_ms: 10,
            cancelled: false,
        },
    }
}

#[test]
fn ipc_rejects_trailing_unknown_oversized_and_wrong_version_input() {
    let mut bytes = encode(&envelope()).unwrap();
    bytes.extend_from_slice(b" {}");
    assert!(serve(&bytes[..], Vec::new()).is_err());
    let mut value = serde_json::to_value(envelope()).unwrap();
    value["source"] = "arbitrary code".into();
    assert!(serve(&encode(&value).unwrap()[..], Vec::new()).is_err());
    assert_eq!(
        serve(&vec![b' '; MAX_IPC_BYTES + 1][..], Vec::new()),
        Err(XProcessError::IpcBudgetExceeded)
    );
    let mut input = envelope();
    input.version = 2;
    assert_eq!(
        serve(&encode(&input).unwrap()[..], Vec::new()),
        Err(XProcessError::InvalidReceipt)
    );
}

#[test]
fn receipt_binds_version_epoch_request_and_output_hash() {
    let input = envelope();
    let mut output = Vec::new();
    serve(&encode(&input).unwrap()[..], &mut output).unwrap();
    let good = validate_receipt(&output, &input.request, input.budget).unwrap();
    assert!(
        matches!(good.messages()[0], XMessage::Number(value) if value.to_bits() == (-0.0f64).to_bits())
    );
    let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
    for (field, replacement) in [
        ("expected_epoch", serde_json::json!(8)),
        ("started_at_ms", serde_json::json!(11)),
        ("request_hash", serde_json::json!("wrong")),
        ("output_hash", serde_json::json!("wrong")),
    ] {
        let mut corrupt = value.clone();
        corrupt["result"]["Ok"][field] = replacement;
        assert_eq!(
            validate_receipt(&encode(&corrupt).unwrap(), &input.request, input.budget),
            Err(XProcessError::InvalidReceipt)
        );
    }
    let mut corrupt = value;
    corrupt["version"] = 2.into();
    assert_eq!(
        validate_receipt(&encode(&corrupt).unwrap(), &input.request, input.budget),
        Err(XProcessError::InvalidReceipt)
    );
}
