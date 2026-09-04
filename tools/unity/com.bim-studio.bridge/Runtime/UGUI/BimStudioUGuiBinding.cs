using System;
using System.Globalization;
using UnityEngine;
using UnityEngine.UI;

namespace BimStudio.Bridge.UGUI
{
    public enum BimStudioUGuiTarget
    {
        Text,
        SliderValue,
        ToggleValue,
        DropdownValue,
        InputText,
        ImageFill,
        ImageColor,
        CanvasAlpha,
        Interactable
    }

    /// <summary>
    /// uGUI 与 Deep Monkey Studio 清单属性的双向无代码绑定。平台回写使用
    /// SetValueWithoutNotify，防止 Slider、Toggle 等控件形成事件回环。
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class BimStudioUGuiBinding : MonoBehaviour, IBimStudioValueContractBinding, IBimStudioEventContractBinding
    {
        [Tooltip("清单中的属性键。")]
        public string propertyKey;
        public BimStudioUGuiTarget target;
        public Text text;
        public Slider slider;
        public Toggle toggle;
        public Dropdown dropdown;
        public InputField input;
        public Image image;
        public CanvasGroup canvasGroup;
        public Selectable selectable;
        [Tooltip("用户修改控件时发回平台的事件；留空表示只接收平台数据。")]
        public string outputEvent;

        private BimStudioBridge bridge;
        public BimStudioValueSource ContractSource => BimStudioValueSource.Property;
        public string ContractKey => propertyKey;
        public string ContractValueType => target == BimStudioUGuiTarget.ToggleValue || target == BimStudioUGuiTarget.Interactable ? "boolean" : target == BimStudioUGuiTarget.ImageColor ? "color" : target == BimStudioUGuiTarget.Text || target == BimStudioUGuiTarget.InputText ? "string" : "number";
        public string ContractEventName => outputEvent;
        public GameObject ContractObject => gameObject;

        private void OnEnable()
        {
            bridge = FindBridge();
            if (bridge != null) bridge.onProperty.AddListener(Apply);
            AddUiListeners();
        }

        private void OnDisable()
        {
            if (bridge != null) bridge.onProperty.RemoveListener(Apply);
            RemoveUiListeners();
            bridge = null;
        }

        private void Apply(string key, string valueJson)
        {
            if (!string.Equals(key?.Trim(), propertyKey?.Trim(), StringComparison.Ordinal)) return;
            var number = ScalarNumber(valueJson);
            switch (target)
            {
                case BimStudioUGuiTarget.Text: if (text != null) text.text = ScalarString(valueJson); break;
                case BimStudioUGuiTarget.SliderValue: if (slider != null) slider.SetValueWithoutNotify(number); break;
                case BimStudioUGuiTarget.ToggleValue: if (toggle != null) toggle.SetIsOnWithoutNotify(ScalarBool(valueJson)); break;
                case BimStudioUGuiTarget.DropdownValue: if (dropdown != null) dropdown.SetValueWithoutNotify(Mathf.RoundToInt(number)); break;
                case BimStudioUGuiTarget.InputText: if (input != null) input.SetTextWithoutNotify(ScalarString(valueJson)); break;
                case BimStudioUGuiTarget.ImageFill: if (image != null) image.fillAmount = Mathf.Clamp01(number); break;
                case BimStudioUGuiTarget.ImageColor:
                    if (image != null && ColorUtility.TryParseHtmlString(ScalarString(valueJson), out var color)) image.color = color;
                    break;
                case BimStudioUGuiTarget.CanvasAlpha: if (canvasGroup != null) canvasGroup.alpha = Mathf.Clamp01(number); break;
                case BimStudioUGuiTarget.Interactable: if (selectable != null) selectable.interactable = ScalarBool(valueJson); break;
            }
        }

        private void AddUiListeners()
        {
            if (string.IsNullOrWhiteSpace(outputEvent)) return;
            slider?.onValueChanged.AddListener(EmitNumber);
            toggle?.onValueChanged.AddListener(EmitBool);
            dropdown?.onValueChanged.AddListener(EmitInteger);
            input?.onValueChanged.AddListener(EmitString);
        }

        private void RemoveUiListeners()
        {
            slider?.onValueChanged.RemoveListener(EmitNumber);
            toggle?.onValueChanged.RemoveListener(EmitBool);
            dropdown?.onValueChanged.RemoveListener(EmitInteger);
            input?.onValueChanged.RemoveListener(EmitString);
        }

        private void EmitNumber(float value) => Emit(value.ToString(CultureInfo.InvariantCulture));
        private void EmitInteger(int value) => Emit(value.ToString(CultureInfo.InvariantCulture));
        private void EmitBool(bool value) => Emit(value ? "true" : "false");
        private void EmitString(string value) => Emit(JsonUtility.ToJson(new StringEnvelope { value = value ?? string.Empty }));
        private void Emit(string json) { if (!string.IsNullOrWhiteSpace(outputEvent)) BimStudioEvents.Emit(outputEvent.Trim(), json); }

        private static BimStudioBridge FindBridge()
        {
#if UNITY_2023_1_OR_NEWER
            return FindFirstObjectByType<BimStudioBridge>();
#else
            return FindObjectOfType<BimStudioBridge>();
#endif
        }

        private static float ScalarNumber(string json) => float.TryParse(ScalarString(json), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : 0f;
        private static bool ScalarBool(string json) => string.Equals(ScalarString(json), "true", StringComparison.OrdinalIgnoreCase) || Math.Abs(ScalarNumber(json)) > float.Epsilon;
        private static string ScalarString(string json)
        {
            var value = (json ?? string.Empty).Trim();
            if (value.Length < 2 || value[0] != '"' || value[value.Length - 1] != '"') return value;
            try { return JsonUtility.FromJson<StringEnvelope>("{\"value\":" + value + "}").value ?? string.Empty; }
            catch { return value.Substring(1, value.Length - 2); }
        }

        [Serializable] private sealed class StringEnvelope { public string value; }
    }
}
