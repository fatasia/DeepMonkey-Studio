using System;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.SceneManagement;

namespace BimStudio.Bridge
{
    [DisallowMultipleComponent]
    public sealed class BimStudioBridge : MonoBehaviour
    {
        [Serializable] public sealed class JsonMessageEvent : UnityEvent<string> { }
        [Serializable] public sealed class KeyValueJsonEvent : UnityEvent<string, string> { }
        [Serializable] private sealed class KeyValueEnvelope { public string key; public string valueJson; }

        public JsonMessageEvent onInit = new JsonMessageEvent();
        public JsonMessageEvent onParameters = new JsonMessageEvent();
        public JsonMessageEvent onData = new JsonMessageEvent();
        public JsonMessageEvent onDataLayers = new JsonMessageEvent();
        public KeyValueJsonEvent onDataLayer = new KeyValueJsonEvent();
        public KeyValueJsonEvent onProperty = new KeyValueJsonEvent();
        public JsonMessageEvent onProperties = new JsonMessageEvent();
        public JsonMessageEvent onAction = new JsonMessageEvent();
        public JsonMessageEvent onScene = new JsonMessageEvent();

        private void Awake() { DontDestroyOnLoad(gameObject); }

        public void ApplyStudioMessage(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return;
            var source = ReadString(json, "source");
            var version = ReadInt(json, "version");
            if (source != "bim-studio" || version != 1) return;
            var messageType = ReadString(json, "type");
            var messageId = ReadString(json, "messageId");
            var handled = true;
            switch (messageType)
            {
                case "init":
                    onInit.Invoke(json);
                    BimStudioEvents.Capabilities("[\"ack\",\"heartbeat\",\"data-layers\",\"properties\",\"actions\",\"events\"]");
                    break;
                case "parameters": onParameters.Invoke(json); break;
                case "data": onData.Invoke(json); break;
                case "dataLayers": onDataLayers.Invoke(json); break;
                case "properties": onProperties.Invoke(json); break;
                case "action": onAction.Invoke(json); break;
                case "scene": onScene.Invoke(json); break;
                case "ping":
                    var delta = Mathf.Max(Time.unscaledDeltaTime, 0.0001f);
                    BimStudioEvents.Health(messageId, Mathf.Min(1f / delta, 999f), SceneManager.GetActiveScene().name);
                    break;
                default: handled = false; break;
            }
            // 消息确认由 Unity 主线程在事件分发后发送，宿主可区分“已投递”和“仅 iframe 存活”。
            if (handled && !string.IsNullOrWhiteSpace(messageId)) BimStudioEvents.Ack(messageId, messageType);
        }

        public void ApplyDataLayer(string json) { ApplyKeyValue(json, onDataLayer); }
        public void ApplyProperty(string json) { ApplyKeyValue(json, onProperty); }

        private static void ApplyKeyValue(string json, KeyValueJsonEvent target)
        {
            if (string.IsNullOrWhiteSpace(json)) return;
            try
            {
                var envelope = JsonUtility.FromJson<KeyValueEnvelope>(json);
                if (envelope != null && !string.IsNullOrWhiteSpace(envelope.key)) target.Invoke(envelope.key, envelope.valueJson ?? "null");
            }
            catch (Exception exception) { Debug.LogWarning($"[Deep Monkey Studio Bridge] Invalid key/value message: {exception.Message}"); }
        }

        private static string ReadString(string json, string key)
        {
            var marker = "\"" + key + "\"";
            var start = json.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0) return string.Empty;
            start = json.IndexOf(':', start + marker.Length) + 1;
            while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
            if (start >= json.Length || json[start] != '\"') return string.Empty;
            var end = json.IndexOf('\"', start + 1);
            return end > start ? json.Substring(start + 1, end - start - 1) : string.Empty;
        }

        private static int ReadInt(string json, string key)
        {
            var marker = "\"" + key + "\"";
            var start = json.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0) return 0;
            start = json.IndexOf(':', start + marker.Length) + 1;
            while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
            var end = start;
            while (end < json.Length && char.IsDigit(json[end])) end++;
            return int.TryParse(json.Substring(start, end - start), out var value) ? value : 0;
        }
    }
}
