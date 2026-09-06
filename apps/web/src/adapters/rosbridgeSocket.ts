/** 浏览器传输适配器；协议校验、会话归属与命令权限均由ROS领域层处理。 */
export function createRosbridgeSocket(url: string): WebSocket { return new WebSocket(url); }
