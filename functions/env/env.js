/**
 * Environment Abstraction Layer
 * 提供统一的环境变量读取接口，支持多种后端实现
 */

/**
 * @typedef {Object} EnvAdapter
 * @property {(key: string) => any} get - 获取环境变量
 * @property {() => Object<string, any>} getAll - 获取所有环境变量
 */

// --- 插件注册系统 ---

/** @type {EnvAdapter | null} */
let currentAdapter = null;

/** @type {Array<{name: string, factory: () => EnvAdapter}>} */
const registeredAdapters = [];

/**
 * 注册 ENV 适配器
 * @param {string} name - 适配器名称
 * @param {() => EnvAdapter} factory - 创建适配器实例的工厂函数
 */
export function registerEnvAdapter(name, factory) {
    registeredAdapters.push({ name, factory });
}

/**
 * 初始化默认适配器
 */
function ensureAdapter() {
    if (currentAdapter) {
        return;
    }

    if (registeredAdapters.length === 0) {
        throw new Error("No ENV adapter registered");
    }

    // 使用第一个注册的适配器
    const { factory } = registeredAdapters[0];
    currentAdapter = factory();
}

/**
 * 设置当前使用的适配器
 * @param {EnvAdapter} adapter
 */
export function setEnvAdapter(adapter) {
    currentAdapter = adapter;
}

/**
 * 获取环境变量
 * @param {string} key
 * @returns {any}
 */
export function getEnv(key) {
    ensureAdapter();
    return currentAdapter.get(key);
}

/**
 * 获取所有环境变量
 * @returns {Object<string, any>}
 */
export function getAllEnv() {
    ensureAdapter();
    return currentAdapter.getAll();
}

/**
 * 清除当前适配器（用于测试）
 */
export function clearEnvAdapter() {
    currentAdapter = null;
}
