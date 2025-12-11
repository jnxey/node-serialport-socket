const net = require("net");

const HOST = "192.168.1.8"; // 串口服务器 IP
const PORT = 8899; // 串口映射端口

const client = new net.Socket();

client.connect(PORT, HOST, function () {
  console.log("已连接RFID设备");

  // 示例命令（必须是Buffer）
  const cmd = Buffer.from([
    0xdd, 0x11, 0xef, 0x09, 0x01, 0x01, 0x01, 0x7d, 0x5,
  ]);
  client.write(cmd);
});

// 接收数据
client.on("data", (data) => {
  const result = [];
  data.forEach((item) => {
    result.push(Number(item).toString(16).padStart(2, "0"));
  });
  console.log("收到RFID数据:", result.join(" "));
});

// 出错
client.on("error", (err) => {
  console.error("Socket错误:", err);
});

// 断开
client.on("close", () => {
  console.log("连接关闭");
});
