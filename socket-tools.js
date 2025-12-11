module.exports = {
  byteToHex: function (value) {
    return Array.from(value).map((v) => v.toString(16).padStart(2, "0"));
  },
  hexStringToBuffer: function (hexStr) {
    return Buffer.from(hexStr.replace(/\s+/g, ""), "hex");
  },
  getParams: function (value) {
    return JSON.stringify(value);
  },
  getJSON: function (value, def) {
    if (!value) return def;
    try {
      return JSON.parse(value);
    } catch (e) {
      return def;
    }
  },
};
