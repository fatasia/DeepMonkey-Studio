mergeInto(LibraryManager.library, {
  BimStudioEmit: function (eventNamePtr, payloadJsonPtr) {
    var eventName = UTF8ToString(eventNamePtr);
    var payloadJson = UTF8ToString(payloadJsonPtr);
    var payload = null;
    try { payload = payloadJson ? JSON.parse(payloadJson) : null; } catch (error) { payload = payloadJson; }
    if (window.BimStudioUnityBridge) window.BimStudioUnityBridge.emit(eventName, payload);
  },
  BimStudioError: function (messagePtr) {
    if (window.BimStudioUnityBridge) window.BimStudioUnityBridge.error(UTF8ToString(messagePtr));
  },
  BimStudioAck: function (messageIdPtr, messageTypePtr) {
    if (window.BimStudioUnityBridge) window.BimStudioUnityBridge.ack(UTF8ToString(messageIdPtr), UTF8ToString(messageTypePtr));
  },
  BimStudioHealth: function (messageIdPtr, fps, scenePtr) {
    if (window.BimStudioUnityBridge) window.BimStudioUnityBridge.health(UTF8ToString(messageIdPtr), fps, UTF8ToString(scenePtr));
  },
  BimStudioCapabilities: function (jsonPtr) {
    var values = [];
    try { values = JSON.parse(UTF8ToString(jsonPtr)); } catch (error) { values = []; }
    if (window.BimStudioUnityBridge) window.BimStudioUnityBridge.capabilities(values);
  }
});
