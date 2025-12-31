/**
 * Cloudflare Worker Config Provider
 * 从 Worker env 对象读取配置
 */

import { registerProvider } from "../config.js";

/** @type {Object<string, any> | null} */
let workerEnv = null;

/**
 * 设置 Cloudflare Worker 环境对象
 * 需要在 Worker 入口处调用
 * @param {Object} env
 */
export function setWorkerEnv(env) {
  workerEnv = env;
}

/**
 * 从 Worker env 加载配置
 * @returns {Promise<Object<string, any>>}
 */
async function loadFromWorkerEnv() {
  return workerEnv || {};
}

// 检测 Cloudflare Workers 环境并自动注册
// caches 存在且 EdgeKV 不存在时认为是 CF 环境
if (typeof caches !== "undefined" && typeof EdgeKV === "undefined") {
  registerProvider("cfenv", loadFromWorkerEnv);
}

export { loadFromWorkerEnv };
