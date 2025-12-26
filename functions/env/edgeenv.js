/**
 * EdgeKV ENV Adapter for Alibaba Cloud ESA
 * 从 EdgeKV 读取环境变量，使用单个 JSON 对象存储所有配置
 */

import { registerEnvAdapter } from "./env.js";

/** @type {Object<string, any>} */
let envCache = {};

/** @type {boolean} */
let loaded = false;

/** @type {EdgeKV | null} */
let kvInstance = null;

/** 环境变量存储的 namespace 和 key */
const ENV_NAMESPACE = "megashare-config";
const ENV_KEY = "env";

/**
 * 获取 EdgeKV 实例
 * @returns {EdgeKV}
 */
function getKVInstance() {
    if (!kvInstance) {
        kvInstance = new EdgeKV({ namespace: ENV_NAMESPACE });
    }
    return kvInstance;
}

/**
 * 从 KV 加载环境变量到缓存
 * 需要在请求开始时调用
 */
export async function loadEnv() {
    if (loaded) {
        return;
    }

    try {
        const kv = getKVInstance();
        const data = await kv.get(ENV_KEY, { type: "json" });
        envCache = data || {};
    } catch (e) {
        console.error("Failed to load env from EdgeKV:", e);
        envCache = {};
    }

    loaded = true;
}

/**
 * 直接设置缓存（用于测试或外部初始化）
 * @param {Object<string, any>} env
 */
export function setEnvCache(env) {
    envCache = env;
    loaded = true;
}

/**
 * 清除缓存（用于测试或强制重新加载）
 */
export function clearEnvCache() {
    envCache = {};
    loaded = false;
}

/**
 * 创建 EdgeKV ENV 适配器
 * @returns {import('./env.js').EnvAdapter}
 */
function createEdgeEnvAdapter() {
    return {
        get(key) {
            if (!loaded) {
                console.warn("EdgeEnv not loaded. Call loadEnv() first.");
            }
            return envCache[key];
        },

        getAll() {
            if (!loaded) {
                console.warn("EdgeEnv not loaded. Call loadEnv() first.");
            }
            return { ...envCache };
        },
    };
}

// 检测 EdgeKV 是否可用并自动注册
if (typeof EdgeKV !== "undefined") {
    registerEnvAdapter("edgeenv", createEdgeEnvAdapter);
}

export { createEdgeEnvAdapter };
