/**
 * Cloudflare KV Adapter
 * 支持 Cloudflare Workers KV
 */

import { registerKVAdapter } from "./kv.js";

// Cloudflare Worker 环境中的 KV binding 引用
// 需要在 wrangler.toml 中配置对应的 KV namespace
let kvBindings = null;

/**
 * 设置 Cloudflare KV bindings（从 Worker env 传入）
 * @param {Object} env - Cloudflare Worker 环境对象
 */
export function setCloudflareEnv(env) {
    kvBindings = env;
}

/**
 * Cloudflare KV 适配器
 * @param {string} namespace - 命名空间（映射到 wrangler.toml 中的 binding 名称）
 * @returns {import('./kv.js').KVAdapter}
 */
function createCloudflareKVAdapter(namespace) {
    // 命名空间到 binding 名称的映射
    const bindingMap = {
        "megashare-metadata": "KV_METADATA",
        "megashare-config": "KV_CONFIG",
    };

    const bindingName = bindingMap[namespace] || namespace.toUpperCase().replace(/-/g, "_");

    return {
        async get(key, options = {}) {
            if (!kvBindings || !kvBindings[bindingName]) {
                throw new Error(`Cloudflare KV binding "${bindingName}" not found. Check wrangler.toml configuration.`);
            }

            const kv = kvBindings[bindingName];
            const type = options.type || "text";

            if (type === "json") {
                return kv.get(key, { type: "json" });
            }
            return kv.get(key, { type: "text" });
        },

        async put(key, value, options = {}) {
            if (!kvBindings || !kvBindings[bindingName]) {
                throw new Error(`Cloudflare KV binding "${bindingName}" not found`);
            }

            const kv = kvBindings[bindingName];
            const data = typeof value === "object" ? JSON.stringify(value) : value;

            if (options.expirationTtl) {
                await kv.put(key, data, { expirationTtl: options.expirationTtl });
            } else {
                await kv.put(key, data);
            }
        },

        async delete(key) {
            if (!kvBindings || !kvBindings[bindingName]) {
                throw new Error(`Cloudflare KV binding "${bindingName}" not found`);
            }

            const kv = kvBindings[bindingName];
            await kv.delete(key);
        },
    };
}

// 检测 Cloudflare Workers 环境（通过 caches 全局对象判断）
// 注意：实际注册需要在 Worker 入口处调用 setCloudflareEnv 后才能使用
if (typeof caches !== "undefined" && typeof EdgeKV === "undefined") {
    registerKVAdapter("cfkv", createCloudflareKVAdapter);
}

export { createCloudflareKVAdapter };
