/**
 * EdgeKV Config Provider for Alibaba Cloud ESA
 * 从 EdgeKV 读取配置（JSON 对象）
 */

import { registerProvider } from "../config.js";

const NAMESPACE = "megashare-config";
const KEY = "env";

/**
 * 从 EdgeKV 加载配置
 * @returns {Promise<Object<string, any>>}
 */
async function loadFromEdgeKV() {
  const kv = new EdgeKV({ namespace: NAMESPACE });
  const data = await kv.get(KEY, { type: "json" });
  return data || {};
}

// 检测 EdgeKV 是否可用并自动注册
if (typeof EdgeKV !== "undefined") {
  registerProvider("edgekv", loadFromEdgeKV);
}

export { loadFromEdgeKV };
