const WebSocket = require("ws");
const net = require("net");
const { randomUUID } = require("crypto");
const tools = require("./socket-tools");
const scanFast = require("./socket-ping");

const PORT = 9989;

const wsServer = new WebSocket.Server({
  port: PORT,
  verifyClient: (info, done) => done(true),
});

const socketServer = {};

wsServer.on("connection", (ws) => {
  console.log("WebSocket connected");
  ws.uuid = randomUUID();
  console.log("新连接:", ws.uuid);

  // WebSocket → 设备
  ws.on("message", async (message) => {
    const info = tools.getJSON(message, {});
    if (info.action === "open") {
      // 连接设备
      const rIP = String(info.rIP);
      const rIPInfo = rIP.split("_");
      const port = Number(rIPInfo[1]);
      const ip = rIPInfo[0];
      socketServer[ws.uuid] = new net.Socket();
      socketServer[ws.uuid].connect(port, ip, () => {
        console.log("Socket connected");
        ws.send(tools.getParams({ type: "open-success" }));
      });

      // 设备 → WebSocket
      socketServer[ws.uuid].on("data", (data) => {
        ws.send(tools.getParams({ type: "data", data: data }));
      });

      // 关闭
      socketServer[ws.uuid].on("close", () => {
        ws.close();
      });

      ws.on("close", () => {
        console.log("--Ws Close--");
        socketServer[ws.uuid].destroy();
        delete socketServer[ws.uuid];
      });
    } else if (info.action === "ports") {
      // 获取有那些网络设备
      const devices = await scanFast(info.port);
      ws.send(tools.getParams({ type: "ports", data: devices }));
    } else if (info.action === "send") {
      // 发送消息
      if (!socketServer[ws.uuid]) {
        return ws.send(
          tools.getParams({ type: "error", msg: "Not Found Device" }),
        );
      } else {
        socketServer[ws.uuid].write(Buffer.from(info.data));
      }
    }
  });
});
