/**
 * RFID 直连示例（不经过 WebSocket 桥接）
 *
 * 用法：修改 HOST / PORT 后执行 node socket-demo.js
 * 用于验证网关 TCP 与读卡指令是否正常。
 */

const net = require("net");
const { byteToHex } = require("./socket-tools");

const HOST = "192.168.1.8"; // 串口/RFID 网关 IP
const PORT = 8899; // 网关映射的 TCP 端口

const client = new net.Socket();

client.connect(PORT, HOST, () => {
  console.log("已连接 RFID 设备");

  // 示例读卡指令（具体帧格式以设备协议为准）
  const cmd = Buffer.from([
    0xdd, 0x11, 0xef, 0x09, 0x01, 0x01, 0x01, 0x7d, 0x05,
  ]);
  client.write(cmd);
});

client.on("data", (data) => {
  console.log("收到 RFID 数据:", byteToHex(data).join(" "));
});

client.on("error", (err) => {
  console.error("Socket 错误:", err);
});

client.on("close", () => {
  console.log("连接关闭");
});
