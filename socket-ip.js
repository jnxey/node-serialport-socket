/**
 * 按网段规则选取本机局域网 IP（用于 RFID 项目固定网段，如 192.168.80+）。
 * 与 socket-ping 的扫描逻辑独立，供上层配置或展示本机地址时使用。
 */

const os = require("os");

/**
 * 选取第一个满足条件的 IPv4 地址：
 * - 非回环
 * - 第三段 octet >= 80（项目内区分 RFID 专网的约定）
 */
function findLocalIPByRule() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const thirdOctet = Number(addr.address.split(".")[2]);
      if (thirdOctet >= 80) return addr.address;
    }
  }
  return null;
}

module.exports = { findLocalIPByRule };

// 直接运行此文件时打印结果，便于命令行调试
if (require.main === module) {
  console.log(findLocalIPByRule());
}
