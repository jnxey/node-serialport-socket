/**
 * WebSocket 与 TCP 之间共用的数据格式工具。
 */

/** 将 Buffer / Uint8Array 转为两位十六进制字符串数组 */
function byteToHex(value) {
  return Array.from(value).map((v) => v.toString(16).padStart(2, "0"));
}

/** 将带空格的十六进制字符串转为 Buffer，用于下发 RFID 指令 */
function hexStringToBuffer(hexStr) {
  return Buffer.from(hexStr.replace(/\s+/g, ""), "hex");
}

/** 封装 WebSocket 下行消息（统一 JSON 字符串） */
function getParams(value) {
  return JSON.stringify(value);
}

/** 解析 WebSocket 上行消息，失败时返回默认值 */
function getJSON(value, def) {
  if (!value) return def;
  try {
    return JSON.parse(value);
  } catch {
    return def;
  }
}

module.exports = {
  byteToHex,
  hexStringToBuffer,
  getParams,
  getJSON,
};
