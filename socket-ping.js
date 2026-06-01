/**
 * 局域网 RFID 设备扫描：在指定 TCP 端口上探测存活主机，并尝试读取 ARP MAC。
 *
 * 典型场景：串口/RFID 网关将设备映射为网口 TCP 服务（如 8899），
 * 本模块在 192.168.x.1–254 上并发探测该端口。
 */

const net = require("net");
const os = require("os");
const { exec } = require("child_process");

/** 单 IP 探测超时（毫秒），越小扫描越快，但易漏检 */
const SCAN_TIMEOUT_MS = 100;
/** 并发探测数，避免 254 路同时 connect 占满句柄 */
const SCAN_CONCURRENCY = 64;

/**
 * 取本机第一个非回环 IPv4 的 /24 前缀（如 192.168.101.10 → 192.168.101）
 */
function getLocalSubnet() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const parts = addr.address.split(".");
      if (parts.length !== 4) continue;
      return parts.slice(0, 3).join(".");
    }
  }
  throw new Error("未找到可用于扫描的 IPv4 网卡");
}

/** 检测目标 IP:port 是否有 TCP 服务监听 */
function checkPort(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(SCAN_TIMEOUT_MS);

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
    socket.connect(port, ip);
  });
}

/** 通过系统 ARP 表解析 MAC（Windows: arp -a） */
function parseMac(ip) {
  return new Promise((resolve) => {
    exec(`arp -a ${ip}`, (_err, stdout) => {
      const m = stdout.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
      resolve(m ? m[0] : null);
    });
  });
}

/** 限制并发执行异步任务 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * 扫描当前网段内开放 port 的设备
 * @param {number} port - RFID/串口网关 TCP 端口
 * @returns {Promise<Array<{ ip: string, mac: string|null, port: number }>>}
 */
async function scanFast(port) {
  const subnet = getLocalSubnet();
  console.log("📡 扫描网段:", subnet + ".x", "端口:", port);

  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);

  const found = await mapWithConcurrency(ips, SCAN_CONCURRENCY, async (ip) => {
    if (!(await checkPort(ip, port))) return null;
    const mac = await parseMac(ip);
    return { ip, mac, port };
  });

  return found.filter(Boolean);
}

module.exports = scanFast;
