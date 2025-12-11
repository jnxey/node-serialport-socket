// rollup.config.js
import resolve from "@rollup/plugin-node-resolve"; // 解析node_modules中的第三方模块
import babel from "@rollup/plugin-babel"; // 使用Babel转换JavaScript代码
import { terser } from "rollup-plugin-terser"; // 压缩JavaScript代码
import commonjs from "@rollup/plugin-commonjs";

export default {
  // 入口文件路径
  input: "./socket-server.js",
  // 输出配置
  output: [
    {
      file: "../electron-app/socket-server.js", // 输出文件路径
      format: "cjs", // ES模块格式，适合现代打包工具
      sourcemap: false, // 生成sourcemap便于调试
    },
  ],
  // 插件配置
  plugins: [
    // 解析node_modules中的模块
    resolve({
      browser: true, // 解析浏览器环境模块
      preferBuiltins: true,
    }),
    commonjs({ ignore: ["serialport", "ws"] }),
    // Babel转换，确保代码浏览器兼容性
    babel({
      babelHelpers: "bundled",
      exclude: "node_modules/**", // 排除node_modules
      extensions: [".js", ".jsx", ".ts", ".tsx"], // 支持的文件扩展名
      presets: [
        [
          "@babel/preset-env",
          {
            targets: ">0.25%, not dead", // 或指定 IE11: { ie: "11" }
            modules: false,
          },
        ],
      ],
    }),
    // 生产环境代码压缩
    terser(),
  ],
};
