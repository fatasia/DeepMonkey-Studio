using System.Runtime.InteropServices;
using UnityEngine;

namespace BimStudio.Bridge
{
    public static class BimStudioEvents
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern void BimStudioEmit(string eventName, string payloadJson);
        [DllImport("__Internal")] private static extern void BimStudioError(string message);
        [DllImport("__Internal")] private static extern void BimStudioAck(string messageId, string messageType);
        [DllImport("__Internal")] private static extern void BimStudioHealth(string messageId, float fps, string scene);
        [DllImport("__Internal")] private static extern void BimStudioCapabilities(string capabilitiesJson);
#endif

        public static void Emit(string eventName, string payloadJson = "null")
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            BimStudioEmit(eventName, payloadJson ?? "null");
#else
            Debug.Log($"[Deep Monkey Studio event] {eventName}: {payloadJson}");
#endif
        }

        public static void Error(string message)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            BimStudioError(message ?? "Unity error");
#else
            Debug.LogError(message);
#endif
        }

        internal static void Ack(string messageId, string messageType)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            BimStudioAck(messageId ?? string.Empty, messageType ?? string.Empty);
#else
            Debug.Log($"[Deep Monkey Studio ack] {messageType}: {messageId}");
#endif
        }

        internal static void Health(string messageId, float fps, string scene)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            BimStudioHealth(messageId ?? string.Empty, fps, scene ?? string.Empty);
#else
            Debug.Log($"[Deep Monkey Studio health] {scene}: {fps:F1} FPS");
#endif
        }

        internal static void Capabilities(string capabilitiesJson)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            BimStudioCapabilities(capabilitiesJson ?? "[]");
#else
            Debug.Log($"[Deep Monkey Studio capabilities] {capabilitiesJson}");
#endif
        }
    }
}
