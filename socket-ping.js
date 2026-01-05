const net = require("net");
const os = require("os");
const { exec } = require("child_process");

const timeout = 100; // 极短超时，极速扫描

// 获取本机局域网子网前缀，例如 "192.168.101 -> 192.168.255"
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

function checkPort(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.connect(port, ip, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      resolve(false);
    });
  });
}

function parseMac(ip) {
  return new Promise((resolve) => {
    exec(`arp -a ${ip}`, (err, stdout) => {
      const m = stdout.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
      resolve(m ? m[0] : null);
    });
  });
}

async function scanFast(port) {
  const subnet = getLocalSubnet();
  console.log("📡 扫描网段:", subnet);

  const tasks = [];

  for (let i = 1; i <= 254; i++) {
    const ip = subnet + "." + i;

    tasks.push(
      (async () => {
        let found = false;

        const ok = await checkPort(ip, port);

        if (ok) found = true;

        if (!found) return null;

        const mac = await parseMac(ip);

        return { ip, mac, port: port };
      })(),
    );
  }

  const res = await Promise.all(tasks);
  return res.filter((x) => x);
}

module.exports = scanFast;
// scanFast(8899).then((r) => console.log(r));
