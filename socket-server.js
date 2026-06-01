const WebSocket = require("ws");
const https = require("https");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { randomUUID } = require("crypto");
const selfsigned = require("selfsigned");
const tools = require("./socket-tools");
const scanFast = require("./socket-ping");

const PORT = 9989;
const CERT_DIR = path.join(__dirname, "certs");
const CERT_PATH = process.env.WSS_CERT || path.join(CERT_DIR, "cert.pem");
const KEY_PATH = process.env.WSS_KEY || path.join(CERT_DIR, "key.pem");

async function ensureTlsCerts() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  const { cert, private: key } = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    { notAfterDate: notAfter, keySize: 2048 },
  );
  fs.writeFileSync(CERT_PATH, cert);
  fs.writeFileSync(KEY_PATH, key);
  console.warn(`已生成自签名 WSS 证书: ${CERT_PATH}`);
}

async function loadTlsOptions() {
  await ensureTlsCerts();
  return {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  };
}

const socketServer = {};

async function start() {
  const httpsServer = https.createServer(await loadTlsOptions());
  const wsServer = new WebSocket.Server({
    server: httpsServer,
    verifyClient: (info, done) => done(true),
  });

  httpsServer.listen(PORT, () => {
    console.log(`WebSocket Open: wss://localhost:${PORT}`);
  });

  wsServer.on("connection", (ws) => {
    console.log("WebSocket connected");
    ws.uuid = randomUUID();
    console.log("新连接:", ws.uuid);

    ws.on("message", async (message) => {
      const info = tools.getJSON(message, {});
      if (info.action === "open") {
        const rIP = String(info.rIP);
        const rIPInfo = rIP.split("_");
        const port = Number(rIPInfo[1]);
        const ip = rIPInfo[0];
        socketServer[ws.uuid] = new net.Socket();
        socketServer[ws.uuid].connect(port, ip, () => {
          console.log("Socket connected");
          ws.send(tools.getParams({ type: "open-success" }));
        });

        socketServer[ws.uuid].on("data", (data) => {
          ws.send(tools.getParams({ type: "data", data: data }));
        });

        socketServer[ws.uuid].on("close", () => {
          ws.close();
        });

        ws.on("close", () => {
          console.log("--Ws Close--");
          socketServer[ws.uuid].destroy();
          delete socketServer[ws.uuid];
        });
      } else if (info.action === "ports") {
        const devices = await scanFast(info.port);
        ws.send(tools.getParams({ type: "ports", data: devices }));
      } else if (info.action === "send") {
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
}

start().catch((err) => {
  console.error("WebSocket 服务启动失败:", err);
  process.exit(1);
});

// 捕获所有未处理异常 → 不退出
process.on("uncaughtException", (err) => {
  console.error("未捕获异常:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("未处理 Promise Rejection:", reason);
});
