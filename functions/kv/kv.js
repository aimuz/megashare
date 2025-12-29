/**
 * KV Storage Abstraction Layer
 * 提供统一的 KV 存储接口，支持多种后端实现
 */

/**
 * @typedef {Object} KVAdapter
 * @property {(key: string, options?: {type?: 'text'|'json'}) => Promise<any>} get - 获取值
 * @property {(key: string, value: string|object, options?: {expirationTtl?: number}) => Promise<void>} put - 存储值
 * @property {(key: string) => Promise<void>} delete - 删除值
 * @property {(options?: {prefix?: string}) => Promise<{keys: {name: string}[]}>} list - 列出键
 */

// --- 插件注册系统 ---

/** @type {Object<string, (namespace: string) => KVAdapter>} */
const adapters = {};

/** @type {Object<string, KVAdapter>} */
const instances = {};

/**
 * 注册 KV 适配器
 * @param {string} name - 适配器名称
 * @param {(namespace: string) => KVAdapter} factory - 创建适配器实例的工厂函数
 */
export function registerKVAdapter(name, factory) {
    adapters[name] = factory;
}

/**
 * 获取 KV 适配器实例
 * @param {string} namespace - 命名空间
 * @returns {KVAdapter}
 */
export function getKV(namespace) {
    // 缓存实例
    if (instances[namespace]) {
        return instances[namespace];
    }

    // 按优先级尝试适配器
    const adapterNames = Object.keys(adapters);
    if (adapterNames.length === 0) {
        throw new Error("No KV adapter registered");
    }

    // 使用第一个可用的适配器
    const factory = adapters[adapterNames[0]];
    instances[namespace] = factory(namespace);
    return instances[namespace];
}

/**
 * 清除缓存的 KV 实例（用于测试）
 */
export function clearKVCache() {
    for (const key of Object.keys(instances)) {
        delete instances[key];
    }
}
