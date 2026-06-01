/**
 * RFID 设备桥接服务（WSS）
 *
 * 浏览器 / Electron 客户端通过 WebSocket 与本服务通信，本服务再与
 * 局域网内 RFID 网关（TCP，常见端口如 8899）建立 Socket 连接。
 *
 * 消息协议（JSON）：
 * - { action: "ports", port: 8899 }  扫描局域网开放该端口的设备
 * - { action: "open",  rIP: "192.168.1.8_8899" }  连接设备（ip_port）
 * - { action: "send",  data: [...] }  向已连接设备写入字节数组
 *
 * 下行 type：ports | open-success | data | error
 */

const WebSocket = require("ws");
const https = require("https");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { randomUUID } = require("crypto");
const selfsigned = require("selfsigned");
const tools = require("./socket-tools");
const scanFast = require("./socket-ping");

const WSS_PORT = 9989;
const CERT_DIR = path.join(__dirname, "certs");
const CERT_PATH = process.env.WSS_CERT || path.join(CERT_DIR, "cert.pem");
const KEY_PATH = process.env.WSS_KEY || path.join(CERT_DIR, "key.pem");

/** ws.uuid → net.Socket，每个 WebSocket 会话最多一条设备 TCP 连接 */
const deviceSockets = {};

/** 解析客户端传入的 "ip_port" */
function parseDeviceAddress(rIP) {
  const [ip, portStr] = String(rIP).split("_");
  const port = Number(portStr);
  if (!ip || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { ip, port };
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(tools.getParams(payload));
  }
}

/** 关闭并清理该 WebSocket 会话关联的设备 TCP 连接 */
function closeDevice(ws) {
  const sock = deviceSockets[ws.uuid];
  if (!sock) return;
  sock.removeAllListeners();
  sock.destroy();
  delete deviceSockets[ws.uuid];
}

/** 建立到 RFID 网关的 TCP 连接，并把数据/状态转发回 WebSocket */
function connectDevice(ws, ip, port) {
  closeDevice(ws);

  const sock = new net.Socket();
  deviceSockets[ws.uuid] = sock;

  sock.on("connect", () => {
    console.log(`设备已连接 ${ip}:${port} (${ws.uuid})`);
    send(ws, { type: "open-success" });
  });

  sock.on("data", (data) => {
    send(ws, { type: "data", data });
  });

  sock.on("close", () => {
    closeDevice(ws);
    ws.close();
  });

  sock.on("error", (err) => {
    console.error(`设备连接错误 ${ip}:${port}`, err.message);
    send(ws, { type: "error", msg: err.message });
    closeDevice(ws);
  });

  sock.connect(port, ip);
}

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

async function handleMessage(ws, message) {
  const info = tools.getJSON(message, {});

  switch (info.action) {
    case "ports": {
      const port = Number(info.port);
      if (!Number.isFinite(port)) {
        return send(ws, { type: "error", msg: "invalid port" });
      }
      const devices = await scanFast(port);
      send(ws, { type: "ports", data: devices });
      break;
    }
    case "open": {
      const target = parseDeviceAddress(info.rIP);
      if (!target) {
        return send(ws, { type: "error", msg: "invalid rIP, use ip_port" });
      }
      connectDevice(ws, target.ip, target.port);
      break;
    }
    case "send": {
      const sock = deviceSockets[ws.uuid];
      if (!sock) {
        return send(ws, { type: "error", msg: "Not Found Device" });
      }
      sock.write(Buffer.from(info.data));
      break;
    }
    default:
      send(ws, { type: "error", msg: `unknown action: ${info.action}` });
  }
}

async function start() {
  const httpsServer = https.createServer(await loadTlsOptions());
  const wsServer = new WebSocket.Server({
    server: httpsServer,
    verifyClient: (_info, done) => done(true),
  });

  httpsServer.listen(WSS_PORT, () => {
    console.log(`WebSocket 已启动: wss://localhost:${WSS_PORT}`);
  });

  wsServer.on("connection", (ws) => {
    ws.uuid = randomUUID();
    console.log("WebSocket 新连接:", ws.uuid);

    ws.on("message", (message) => {
      handleMessage(ws, message).catch((err) => {
        console.error("处理消息失败:", err);
        send(ws, { type: "error", msg: err.message });
      });
    });

    ws.on("close", () => {
      console.log("WebSocket 断开:", ws.uuid);
      closeDevice(ws);
    });
  });
}

start().catch((err) => {
  console.error("WebSocket 服务启动失败:", err);
  process.exit(1);
});

// 避免未捕获异常导致进程退出（长期驻留服务）
process.on("uncaughtException", (err) => {
  console.error("未捕获异常:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("未处理 Promise Rejection:", reason);
});
