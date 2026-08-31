using UnityEngine;

namespace BimStudio.Bridge
{
    /// <summary>
    /// No-code Unity-to-BIM Studio event bridge. Add this component to a button,
    /// collider, animation event, or any UnityEvent and call Emit.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class BimStudioEventEmitter : MonoBehaviour, IBimStudioEventContractBinding
    {
        [Tooltip("集成清单中声明的 Unity 事件名称。")]
        public string eventName;
        [Tooltip("发送给 BIM Studio 的 JSON；可以是对象、数组、数字、布尔值、字符串或 null。")]
        [TextArea(2, 8)] public string payloadJson = "null";
        public string ContractEventName => eventName;
        public GameObject ContractObject => gameObject;

        public void Emit()
        {
            var name = (eventName ?? string.Empty).Trim();
            if (name.Length == 0)
            {
                BimStudioEvents.Error($"{gameObject.name} 的 BIM Studio 事件名称为空。");
                return;
            }
            BimStudioEvents.Emit(name, string.IsNullOrWhiteSpace(payloadJson) ? "null" : payloadJson.Trim());
        }

        public void EmitString(string value)
        {
            var name = (eventName ?? string.Empty).Trim();
            if (name.Length == 0) { BimStudioEvents.Error($"{gameObject.name} 的 BIM Studio 事件名称为空。"); return; }
            BimStudioEvents.Emit(name, JsonUtility.ToJson(new StringEnvelope { value = value ?? string.Empty }));
        }

        [System.Serializable]
        private sealed class StringEnvelope { public string value; }
    }
}
