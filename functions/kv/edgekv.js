/**
 * EdgeKV Adapter for Alibaba Cloud ESA
 */

import { registerKVAdapter } from "./kv.js";

/**
 * EdgeKV 适配器
 * @param {string} namespace
 * @returns {import('./kv.js').KVAdapter}
 */
function createEdgeKVAdapter(namespace) {
    const kv = new EdgeKV({ namespace });

    return {
        async get(key, options = {}) {
            const type = options.type || "text";
            return kv.get(key, { type });
        },

        async put(key, value, options = {}) {
            const data = typeof value === "object" ? JSON.stringify(value) : value;
            await kv.put(key, data, options);
        },

        async delete(key) {
            await kv.delete(key);
        },

        async list(options = {}) {
            return kv.list(options);
        },
    };
}

// 检测 EdgeKV 是否可用并自动注册
if (typeof EdgeKV !== "undefined") {
    registerKVAdapter("edgekv", createEdgeKVAdapter);
}

export { createEdgeKVAdapter };
