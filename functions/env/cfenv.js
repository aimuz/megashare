/**
 * Cloudflare Workers ENV Adapter
 * 从 Cloudflare Worker 环境对象读取环境变量
 */

import { registerEnvAdapter } from "./env.js";

/** @type {Object<string, any> | null} */
let cfEnv = null;

/**
 * 设置 Cloudflare Worker 环境对象
 * @param {Object} env - Cloudflare Worker 环境对象
 */
export function setCloudflareEnv(env) {
    cfEnv = env;
}

/**
 * 创建 Cloudflare ENV 适配器
 * @returns {import('./env.js').EnvAdapter}
 */
function createCloudflareEnvAdapter() {
    return {
        get(key) {
            if (!cfEnv) {
                return undefined;
            }
            return cfEnv[key];
        },

        getAll() {
            return cfEnv || {};
        },
    };
}

// 检测 Cloudflare Workers 环境
if (typeof caches !== "undefined" && typeof EdgeKV === "undefined") {
    registerEnvAdapter("cfenv", createCloudflareEnvAdapter);
}

export { createCloudflareEnvAdapter };
