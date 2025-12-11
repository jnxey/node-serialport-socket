const os = require("os");
const net = require("net");
const ping = require("ping");
const { exec } = require("child_process");

// ---------- 可配置 ----------
const RFID_PORTS = [8899];
const MAX_CONCURRENT = 100; // 并发扫描控制
// ---------------------------

// 获取本机局域网子网前缀，例如 "192.168.1"
function getLocalSubnet() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address.split(".").slice(0, 3).join(".");
      }
    }
  }
  throw new Error("未找到有效网卡");
}

// ping 探测 IP 是否存活
async function isAlive(ip) {
  try {
    const res = await ping.promise.probe(ip, { timeout: 1 });
    return res.alive;
  } catch {
    return false;
  }
}

// 探测端口是否开放
function checkPort(ip, port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

// 触发端口通信，刷新 ARP 表
async function touchDevice(ip, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(300);
    sock.connect(port, ip, () => {
      sock.destroy();
      resolve();
    });
    sock.on("error", () => resolve());
    sock.on("timeout", () => resolve());
  });
}

// 获取系统 ARP 表
function getArpTable() {
  return new Promise((resolve) => {
    exec("arp -a", (err, stdout) => {
      if (err) return resolve({});
      resolve(parseArp(stdout));
    });
  });
}

// 解析 ARP 表
function parseArp(output) {
  const map = {};
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    // Windows: 192.168.1.1  00-11-22-33-44-55
    let m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([a-f0-9:-]{17})/i);
    if (m) {
      map[m[1]] = m[2].replace(/-/g, ":").toUpperCase();
      continue;
    }
    // Linux/Mac: ? (192.168.1.1) at 00:11:22:33:44:55
    m = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([a-f0-9:]{17})/i);
    if (m) {
      map[m[1]] = m[2].toUpperCase();
    }
  }
  return map;
}

// 扫描单个 IP
async function scanOneIP(ip) {
  const alive = await isAlive(ip);
  if (!alive) return null;

  const openPorts = [];
  for (const port of RFID_PORTS) {
    if (await checkPort(ip, port)) openPorts.push(port);
  }

  if (!openPorts.length) return null;

  // 刷新 ARP
  await touchDevice(ip, openPorts[0]);

  return { ip, ports: openPorts };
}

// 并发执行任务
async function runPool(tasks, limit = 50) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const cur = i++;
      const r = await tasks[cur]();
      if (r) results.push(r);
    }
  }
  const workers = Array(limit).fill(0).map(worker);
  await Promise.all(workers);
  return results;
}

// ---------- 主扫描方法 ----------
async function discoverRFIDWithMac() {
  // const start = Date.now();
  const subnet = getLocalSubnet();
  console.log("📡 扫描网段:", subnet);

  // 构造任务
  const tasks = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    tasks.push(() => scanOneIP(ip));
  }

  let devices = await runPool(tasks, MAX_CONCURRENT);

  // console.log("time1---------" + (Date.now() - start));

  // 等 ARP 更新
  await new Promise((r) => setTimeout(r, 500));

  // console.log("time2---------" + (Date.now() - start));
  const arpTable = await getArpTable();

  // console.log("time3---------" + (Date.now() - start));
  devices = devices.map((d) => ({ ...d, mac: arpTable[d.ip] || "UNKNOWN" }));

  console.log("\n✅ 扫描完成，发现 RFID 设备：");
  console.table(devices);
  return devices;
}

// ---------- 启动 ----------
// discoverRFIDWithMac();
module.exports = discoverRFIDWithMac;
