using System;
using System.Globalization;
using UnityEngine;
using UnityEngine.Events;

namespace BimStudio.Bridge
{
    public enum BimStudioValueSource { DataLayer, Property }
    public interface IBimStudioValueContractBinding
    {
        BimStudioValueSource ContractSource { get; }
        string ContractKey { get; }
        string ContractValueType { get; }
        GameObject ContractObject { get; }
    }
    public interface IBimStudioEventContractBinding
    {
        string ContractEventName { get; }
        GameObject ContractObject { get; }
    }
    public enum BimStudioValueTarget
    {
        GameObjectActive,
        AnimatorFloat,
        AnimatorBool,
        AnimatorTrigger,
        MaterialFloat,
        MaterialColor,
        PositionX,
        PositionY,
        PositionZ,
        RotationX,
        RotationY,
        RotationZ,
        ScaleX,
        ScaleY,
        ScaleZ,
        CameraFieldOfView,
        CameraOrthographicSize,
        LightEnabled,
        LightIntensity,
        LightColor,
        LightRange,
        LightSpotAngle,
        InvokeEvent
    }

    [DisallowMultipleComponent]
    public sealed class BimStudioValueBinding : MonoBehaviour, IBimStudioValueContractBinding
    {
        [Tooltip("选择监听集成清单中的数据层或可配置属性。")]
        public BimStudioValueSource source = BimStudioValueSource.DataLayer;
        [Tooltip("集成清单中稳定的数据层 / 属性标识。")]
        public string key;
        public BimStudioValueTarget target = BimStudioValueTarget.InvokeEvent;
        public GameObject targetObject;
        public Animator animator;
        public Renderer targetRenderer;
        public Camera targetCamera;
        public Light targetLight;
        [Tooltip("Animator 参数名或 Shader 属性名。")]
        public string parameter;
        public BimStudioBridge.JsonMessageEvent onValue = new BimStudioBridge.JsonMessageEvent();

        private BimStudioBridge bridge;
        public BimStudioValueSource ContractSource => source;
        public string ContractKey => key;
        public string ContractValueType => IsBooleanTarget(target) ? "boolean" : IsColorTarget(target) ? "color" : target == BimStudioValueTarget.InvokeEvent ? "string" : "number";
        public GameObject ContractObject => gameObject;

        private void OnEnable()
        {
            bridge = FindBridge();
            if (bridge == null) { Debug.LogWarning($"[BIM Studio 绑定] {name} 未找到 BimStudioBridge。", this); return; }
            if (source == BimStudioValueSource.DataLayer) bridge.onDataLayer.AddListener(Apply);
            else bridge.onProperty.AddListener(Apply);
        }

        private void OnDisable()
        {
            if (bridge == null) return;
            bridge.onDataLayer.RemoveListener(Apply);
            bridge.onProperty.RemoveListener(Apply);
            bridge = null;
        }

        private void Apply(string incomingKey, string valueJson)
        {
            if (!string.Equals(key?.Trim(), incomingKey, StringComparison.Ordinal)) return;
            var gameObjectTarget = targetObject != null ? targetObject : gameObject;
            var transformTarget = gameObjectTarget.transform;
            var numeric = ScalarNumber(valueJson);
            switch (target)
            {
                case BimStudioValueTarget.GameObjectActive: gameObjectTarget.SetActive(ScalarBool(valueJson)); break;
                case BimStudioValueTarget.AnimatorFloat: ResolveAnimator()?.SetFloat(parameter, numeric); break;
                case BimStudioValueTarget.AnimatorBool: ResolveAnimator()?.SetBool(parameter, ScalarBool(valueJson)); break;
                case BimStudioValueTarget.AnimatorTrigger: if (ScalarBool(valueJson)) ResolveAnimator()?.SetTrigger(parameter); break;
                case BimStudioValueTarget.MaterialFloat: ResolveRenderer()?.material.SetFloat(parameter, numeric); break;
                case BimStudioValueTarget.MaterialColor:
                    if (ColorUtility.TryParseHtmlString(ScalarString(valueJson), out var color)) ResolveRenderer()?.material.SetColor(string.IsNullOrWhiteSpace(parameter) ? "_BaseColor" : parameter, color);
                    break;
                case BimStudioValueTarget.PositionX: SetPosition(transformTarget, 0, numeric); break;
                case BimStudioValueTarget.PositionY: SetPosition(transformTarget, 1, numeric); break;
                case BimStudioValueTarget.PositionZ: SetPosition(transformTarget, 2, numeric); break;
                case BimStudioValueTarget.RotationX: SetRotation(transformTarget, 0, numeric); break;
                case BimStudioValueTarget.RotationY: SetRotation(transformTarget, 1, numeric); break;
                case BimStudioValueTarget.RotationZ: SetRotation(transformTarget, 2, numeric); break;
                case BimStudioValueTarget.ScaleX: SetScale(transformTarget, 0, numeric); break;
                case BimStudioValueTarget.ScaleY: SetScale(transformTarget, 1, numeric); break;
                case BimStudioValueTarget.ScaleZ: SetScale(transformTarget, 2, numeric); break;
                case BimStudioValueTarget.CameraFieldOfView: ResolveCamera().fieldOfView = Mathf.Clamp(numeric, 1f, 179f); break;
                case BimStudioValueTarget.CameraOrthographicSize: ResolveCamera().orthographicSize = Mathf.Max(0.01f, numeric); break;
                case BimStudioValueTarget.LightEnabled: ResolveLight().enabled = ScalarBool(valueJson); break;
                case BimStudioValueTarget.LightIntensity: ResolveLight().intensity = Mathf.Max(0f, numeric); break;
                case BimStudioValueTarget.LightColor:
                    if (ColorUtility.TryParseHtmlString(ScalarString(valueJson), out var lightColor)) ResolveLight().color = lightColor;
                    break;
                case BimStudioValueTarget.LightRange: ResolveLight().range = Mathf.Max(0f, numeric); break;
                case BimStudioValueTarget.LightSpotAngle: ResolveLight().spotAngle = Mathf.Clamp(numeric, 1f, 179f); break;
                default: onValue.Invoke(valueJson); break;
            }
        }

        private Animator ResolveAnimator() { return animator != null ? animator : (targetObject != null ? targetObject : gameObject).GetComponent<Animator>(); }
        private Renderer ResolveRenderer() { return targetRenderer != null ? targetRenderer : (targetObject != null ? targetObject : gameObject).GetComponent<Renderer>(); }
        private Camera ResolveCamera() { return targetCamera != null ? targetCamera : (targetObject != null ? targetObject : gameObject).GetComponent<Camera>(); }
        private Light ResolveLight() { return targetLight != null ? targetLight : (targetObject != null ? targetObject : gameObject).GetComponent<Light>(); }
        private static BimStudioBridge FindBridge()
        {
#if UNITY_2023_1_OR_NEWER
            return FindFirstObjectByType<BimStudioBridge>();
#else
            return FindObjectOfType<BimStudioBridge>();
#endif
        }
        private static void SetPosition(Transform value, int axis, float input) { var next = value.localPosition; next[axis] = input; value.localPosition = next; }
        private static void SetRotation(Transform value, int axis, float input) { var next = value.localEulerAngles; next[axis] = input; value.localEulerAngles = next; }
        private static void SetScale(Transform value, int axis, float input) { var next = value.localScale; next[axis] = input; value.localScale = next; }

        private static float ScalarNumber(string json)
        {
            return float.TryParse((json ?? string.Empty).Trim(' ', '"'), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : 0f;
        }

        private static bool ScalarBool(string json)
        {
            var value = ScalarString(json);
            return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) || string.Equals(value, "on", StringComparison.OrdinalIgnoreCase) || (float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && Math.Abs(number) > float.Epsilon);
        }

        private static string ScalarString(string json)
        {
            var value = (json ?? string.Empty).Trim();
            if (value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"')
            {
                try { return JsonUtility.FromJson<StringEnvelope>("{\"value\":" + value + "}").value ?? string.Empty; }
                catch { return value.Substring(1, value.Length - 2); }
            }
            return value;
        }

        private static bool IsBooleanTarget(BimStudioValueTarget value) => value == BimStudioValueTarget.GameObjectActive || value == BimStudioValueTarget.AnimatorBool || value == BimStudioValueTarget.AnimatorTrigger || value == BimStudioValueTarget.LightEnabled;
        private static bool IsColorTarget(BimStudioValueTarget value) => value == BimStudioValueTarget.MaterialColor || value == BimStudioValueTarget.LightColor;

        [Serializable] private sealed class StringEnvelope { public string value; }
    }

    [DisallowMultipleComponent]
    public sealed class BimStudioActionBinding : MonoBehaviour
    {
        public string action;
        [Tooltip("可选的稳定业务对象 ID；留空时接收任意对象的动作。")]
        public string objectId;
        public BimStudioBridge.JsonMessageEvent onTriggered = new BimStudioBridge.JsonMessageEvent();
        private BimStudioBridge bridge;

        private void OnEnable()
        {
            bridge = FindBridge();
            if (bridge != null) bridge.onAction.AddListener(Apply);
        }

        private void OnDisable() { if (bridge != null) bridge.onAction.RemoveListener(Apply); bridge = null; }

        private void Apply(string json)
        {
            if (!string.Equals(ReadString(json, "action"), action?.Trim(), StringComparison.Ordinal)) return;
            var incomingObject = ReadString(json, "objectId");
            if (!string.IsNullOrWhiteSpace(objectId) && !string.Equals(objectId.Trim(), incomingObject, StringComparison.Ordinal)) return;
            onTriggered.Invoke(json);
        }

        private static BimStudioBridge FindBridge()
        {
#if UNITY_2023_1_OR_NEWER
            return FindFirstObjectByType<BimStudioBridge>();
#else
            return FindObjectOfType<BimStudioBridge>();
#endif
        }

        private static string ReadString(string json, string key)
        {
            var marker = "\"" + key + "\"";
            var start = json.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0) return string.Empty;
            start = json.IndexOf(':', start + marker.Length) + 1;
            while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
            if (start >= json.Length || json[start] != '"') return string.Empty;
            var end = json.IndexOf('"', start + 1);
            return end > start ? json.Substring(start + 1, end - start - 1) : string.Empty;
        }
    }
}
