/**
 * 串口 RFID 设备：列举 COM 口、校验参数、打开串口连接。
 *
 * 与 socket-ping.js（网口扫描）对称，供 socket-server.js 在 serial-ports / open-serial 时使用。
 */

const { SerialPort } = require("serialport");

const VALID_DATA_BITS = new Set([5, 6, 7, 8]);
const VALID_STOP_BITS = new Set([1, 2]);
const VALID_PARITY = new Set(["none", "even", "odd", "mark", "space"]);

/** 列举本机可用串口 */
async function listSerialPorts() {
  return SerialPort.list();
}

/**
 * 校验并规范化 open-serial 参数
 * @returns {{ path: string, baudRate: number, dataBits: number, stopBits: number, parity: string } | null}
 */
function parseSerialConfig(info) {
  const path = String(info.path || "").trim();
  const baudRate = Number(info.baudRate);
  const dataBits = Number(info.dataBits);
  const stopBits = Number(info.stopBits);
  const parity = String(info.parity || "").toLowerCase();

  if (!path || !Number.isFinite(baudRate) || baudRate <= 0) return null;
  if (!VALID_DATA_BITS.has(dataBits)) return null;
  if (!VALID_STOP_BITS.has(stopBits)) return null;
  if (!VALID_PARITY.has(parity)) return null;

  return { path, baudRate, dataBits, stopBits, parity };
}

/** 打开串口，在 open 事件 resolve，error 事件 reject */
function openSerialPort(config) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ ...config, autoOpen: true });

    const onError = (err) => {
      port.removeListener("open", onOpen);
      reject(err);
    };

    const onOpen = () => {
      port.removeListener("error", onError);
      resolve(port);
    };

    port.once("open", onOpen);
    port.once("error", onError);
  });
}

module.exports = { listSerialPorts, parseSerialConfig, openSerialPort };
