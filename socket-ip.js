const os = require('os');

function findLocalIPByRule() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      console.log(net.address)
      const mark = Number(net.address.split('.')[2])
      if (
        net.family === 'IPv4' &&
        !net.internal &&
        mark >= 80
      ) {
        return net.address;
      }
    }
  }
  return null;
}

// 示例
const localIP = findLocalIPByRule('192.168.101.10');
console.log(localIP); // 192.168.101.114
