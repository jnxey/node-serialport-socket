/**
 * ============================================================================
 * RFID 设备桥接服务（WSS）
 * ============================================================================
 *
 * 【作用】
 * 本进程作为「中间层」：前端（浏览器 / Electron）无法直接访问局域网 TCP，
 * 因此通过加密的 WebSocket（WSS）与本服务通信；本服务再与 RFID 网关建立
 * 原生 TCP Socket，实现扫描、连接、收发指令。
 *
 * 【典型拓扑】
 *
 *   前端客户端  <--WSS-->  socket-server.js  <--TCP-->  RFID 网关 (如 8899)
 *                              |
 *                         socket-ping.js（扫描时）
 *
 * 【为何使用 WSS】
 * 浏览器/Electron 页面在 HTTPS 或安全上下文中只能连接 wss://，不能使用 ws://。
 * 本服务用 Node https + ws 库在 9989 端口提供 WSS。
 *
 * --------------------------------------------------------------------------
 * 上行消息（客户端 → 服务端，JSON 字符串）
 * --------------------------------------------------------------------------
 *
 * 1. 扫描局域网设备
 *    { "action": "ports", "port": 8899 }
 *    - port：要探测的 TCP 端口（RFID/串口网关映射端口，常见 8899）
 *
 * 2. 连接指定设备
 *    { "action": "open", "rIP": "192.168.1.8_8899" }
 *    - rIP：设备地址，格式固定为「IP_端口」，下划线分隔
 *    - 同一 WebSocket 会话重复 open 会先断开旧 TCP 再连新地址
 *
 * 3. 向已连接设备发送数据
 *    { "action": "send", "data": [221, 17, 239, ...] }
 *    - data：字节数组（十进制 0–255），对应 RFID 协议帧
 *    - 须先 open 成功，否则返回 error
 *
 * --------------------------------------------------------------------------
 * 下行消息（服务端 → 客户端，JSON 字符串）
 * --------------------------------------------------------------------------
 *
 * | type          | 含义           | 字段说明
 * |---------------|----------------|------------------------------------------
 * | ports         | 扫描结果       | data: [{ ip, mac, port }, ...]
 * | open-success  | TCP 连接成功   | 无额外字段，可开始 send
 * | data          | 设备上报数据   | data: Buffer 序列化后的字节（见 tools）
 * | error         | 错误           | msg: 错误描述
 *
 * --------------------------------------------------------------------------
 * 环境变量（可选，生产建议使用正式证书）
 * --------------------------------------------------------------------------
 *
 * WSS_CERT  证书 PEM 路径，默认 ./certs/cert.pem
 * WSS_KEY   私钥 PEM 路径，默认 ./certs/key.pem
 *
 * 首次启动若证书不存在，会自动生成 localhost 自签名证书（仅适合开发）。
 *
 * 启动：node socket-server.js
 * 地址：wss://localhost:9989
 * ============================================================================
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

// ---------------------------------------------------------------------------
// 配置常量
// ---------------------------------------------------------------------------

/** WSS 监听端口，与前端约定一致 */
const WSS_PORT = 9989;

/** 证书存放目录（已加入 .gitignore，勿提交私钥） */
const CERT_DIR = path.join(__dirname, "certs");

/**
 * TLS 证书与私钥路径
 * 可通过环境变量覆盖，便于部署时挂载正式证书
 */
const CERT_PATH = process.env.WSS_CERT || path.join(CERT_DIR, "localhost.pem");
const KEY_PATH = process.env.WSS_KEY || path.join(CERT_DIR, "localhost-key.pem");

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

/**
 * 设备 TCP 连接表
 * 键：ws.uuid（每个 WebSocket 连接唯一 ID）
 * 值：net.Socket（与 RFID 网关的 TCP 连接）
 *
 * 约束：一个 WebSocket 会话同时只维护一条设备 TCP；
 *       断开 WebSocket 或重新 open 时会清理对应条目。
 */
const deviceSockets = {};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 解析客户端传入的设备地址字符串
 *
 * @param {string} rIP - 格式 "192.168.1.8_8899"（IP 与端口用下划线连接）
 * @returns {{ ip: string, port: number } | null} 解析失败返回 null
 *
 * @example
 * parseDeviceAddress("192.168.1.8_8899")  // { ip: "192.168.1.8", port: 8899 }
 * parseDeviceAddress("invalid")           // null
 */
function parseDeviceAddress(rIP) {
  const [ip, portStr] = String(rIP).split("_");
  const port = Number(portStr);
  if (!ip || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { ip, port };
}

/**
 * 向 WebSocket 客户端发送 JSON 消息
 * 仅在连接仍为 OPEN 时发送，避免向已关闭连接写入
 *
 * @param {import("ws")} ws
 * @param {object} payload - 将序列化为 JSON，如 { type: "data", data: [...] }
 */
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(tools.getParams(payload));
  }
}

/**
 * 关闭并清理当前 WebSocket 会话关联的 RFID 设备 TCP 连接
 *
 * - 移除 Socket 上所有监听器，防止 close/error 重复触发
 * - destroy() 立即释放底层连接
 * - 从 deviceSockets 删除映射
 *
 * @param {import("ws") & { uuid: string }} ws
 */
function closeDevice(ws) {
  const sock = deviceSockets[ws.uuid];
  if (!sock) return;
  sock.removeAllListeners();
  sock.destroy();
  delete deviceSockets[ws.uuid];
}

/**
 * 建立到 RFID 网关的 TCP 连接，并配置双向数据转发
 *
 * 流程：
 * 1. 若已有连接则先 closeDevice（支持切换设备）
 * 2. 创建 net.Socket 并注册 connect / data / close / error
 * 3. connect 成功 → 通知客户端 open-success
 * 4. 收到设备数据 → 封装为 { type: "data", data } 转发给 WebSocket
 * 5. 设备 TCP 断开 → 关闭 WebSocket（客户端可重连）
 * 6. TCP 出错 → 下发 error 并清理连接
 *
 * @param {import("ws") & { uuid: string }} ws
 * @param {string} ip   - 网关 IP
 * @param {number} port - 网关 TCP 端口
 */
function connectDevice(ws, ip, port) {
  // 重连前先释放旧 Socket，避免泄漏与重复监听
  closeDevice(ws);

  const sock = new net.Socket();
  deviceSockets[ws.uuid] = sock;

  sock.on("connect", () => {
    console.log(`设备已连接 ${ip}:${port} (${ws.uuid})`);
    send(ws, { type: "open-success" });
  });

  // 设备 → 服务端 → WebSocket → 前端展示/解析 RFID 帧
  sock.on("data", (data) => {
    send(ws, { type: "data", data });
  });

  // 网关主动断开或网络中断：清理 TCP 并关闭 WebSocket
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

// ---------------------------------------------------------------------------
// TLS / WSS 证书
// ---------------------------------------------------------------------------

/**
 * 确保磁盘上存在 TLS 证书与私钥
 *
 * 开发环境：不存在时用 selfsigned 生成自签名证书（CN=localhost，有效期 1 年）
 * 生产环境：请提前放置正式证书，或设置 WSS_CERT / WSS_KEY 指向挂载路径
 */
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

/**
 * 读取 TLS 配置供 https.createServer 使用
 * @returns {Promise<{ cert: Buffer, key: Buffer }>}
 */
async function loadTlsOptions() {
  await ensureTlsCerts();
  return {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  };
}

// ---------------------------------------------------------------------------
// WebSocket 消息分发
// ---------------------------------------------------------------------------

/**
 * 处理单条 WebSocket 文本消息（JSON）
 *
 * @param {import("ws") & { uuid: string }} ws
 * @param {string|Buffer} message - 客户端发来的原始消息
 */
async function handleMessage(ws, message) {
  const info = tools.getJSON(message, {});

  switch (info.action) {
    // 扫描：委托 socket-ping 在本机网段探测指定端口
    case "ports": {
      const port = Number(info.port);
      if (!Number.isFinite(port)) {
        return send(ws, { type: "error", msg: "invalid port" });
      }
      const devices = await scanFast(port);
      send(ws, { type: "ports", data: devices });
      break;
    }

    // 连接：解析 rIP 并建立 TCP
    case "open": {
      const target = parseDeviceAddress(info.rIP);
      if (!target) {
        return send(ws, { type: "error", msg: "invalid rIP, use ip_port" });
      }
      connectDevice(ws, target.ip, target.port);
      break;
    }

    // 下发：将字节数组写入已连接的设备 Socket
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

// ---------------------------------------------------------------------------
// 服务启动
// ---------------------------------------------------------------------------

/**
 * 启动 HTTPS 服务器并在其上挂载 WebSocket.Server
 *
 * verifyClient 当前放行所有握手（内网/本地桥接场景）；
 * 若需鉴权可在此校验 Origin、Token 等。
 */
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
    // 为每个前端连接生成唯一 ID，作为 deviceSockets 的键
    ws.uuid = randomUUID();
    console.log("WebSocket 新连接:", ws.uuid);

    ws.on("message", (message) => {
      handleMessage(ws, message).catch((err) => {
        console.error("处理消息失败:", err);
        send(ws, { type: "error", msg: err.message });
      });
    });

    // 前端关闭或刷新页面：同步释放 RFID TCP，避免网关侧连接残留
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

// ---------------------------------------------------------------------------
// 进程级异常处理（服务需长期运行，不因单次异常退出）
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  console.error("未捕获异常:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("未处理 Promise Rejection:", reason);
});
