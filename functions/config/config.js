/**
 * Viper-like Configuration System
 * 支持多配置源、优先级覆盖、类型转换
 *
 * 优先级（高 → 低）：
 * 1. 显式设置 (set)
 * 2. Provider 配置（EdgeKV / Worker env）
 * 3. 默认值 (setDefault)
 */

/** @type {Object<string, any>} 显式设置的值（最高优先级） */
const overrides = {};

/** @type {Object<string, any>} Provider 加载的配置 */
let providerConfig = {};

/** @type {Object<string, any>} 默认值（最低优先级） */
const defaults = {};

/** @type {Array<{name: string, loader: () => Promise<Object<string, any>>}>} */
const providers = [];

/** @type {boolean} */
let loaded = false;

/**
 * 注册配置 Provider
 * @param {string} name - Provider 名称
 * @param {() => Promise<Object<string, any>>} loader - 加载配置的异步函数
 */
export function registerProvider(name, loader) {
  providers.push({ name, loader });
}

/**
 * 加载配置（从所有 Provider）
 * 应在应用启动时调用一次
 */
async function load() {
  if (loaded) return;

  const promises = providers.map(({ name, loader }) =>
    loader().catch((e) => {
      console.error(`[Config] Failed to load from provider "${name}":`, e);
      return null; // 返回 null 以防止 Promise.all 失败
    }),
  );

  const results = await Promise.all(promises);
  for (const data of results) {
    if (data && typeof data === "object") {
      providerConfig = { ...providerConfig, ...data };
    }
  }
  loaded = true;
}

/**
 * 获取配置值
 * @param {string} key
 * @returns {any}
 */
function get(key) {
  // 优先级：overrides > providerConfig > defaults
  if (key in overrides) return overrides[key];
  if (key in providerConfig) return providerConfig[key];
  if (key in defaults) return defaults[key];
  return undefined;
}

/**
 * 获取字符串配置
 * @param {string} key
 * @param {string} [defaultValue]
 * @returns {string}
 */
function getString(key, defaultValue = "") {
  const val = get(key);
  if (val === undefined || val === null) return defaultValue;
  return String(val);
}

/**
 * 获取整数配置
 * @param {string} key
 * @param {number} [defaultValue]
 * @returns {number}
 */
function getInt(key, defaultValue = 0) {
  const val = get(key);
  if (val === undefined || val === null) return defaultValue;
  const num = parseInt(val, 10);
  return isNaN(num) ? defaultValue : num;
}

/**
 * 获取布尔配置
 * @param {string} key
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
function getBool(key, defaultValue = false) {
  const val = get(key);
  if (val === undefined || val === null) return defaultValue;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    return val.toLowerCase() === "true" || val === "1";
  }
  if (typeof val === "number") {
    return val !== 0;
  }
  // For other types like objects and arrays, return the default value.
  return defaultValue;
}

/**
 * 显式设置配置值（最高优先级）
 * 用于代码中硬编码覆盖配置
 * @param {string} key
 * @param {any} value
 */
function set(key, value) {
  overrides[key] = value;
}

/**
 * 设置默认值
 * @param {string} key
 * @param {any} value
 */
function setDefault(key, value) {
  defaults[key] = value;
}

/**
 * 批量设置默认值
 * @param {Object<string, any>} obj
 */
function setDefaults(obj) {
  Object.assign(defaults, obj);
}

/**
 * 获取所有配置（合并后）
 * @returns {Object<string, any>}
 */
function getAll() {
  return { ...defaults, ...providerConfig, ...overrides };
}

/**
 * 重置配置（用于测试）
 */
function reset() {
  Object.keys(overrides).forEach((k) => delete overrides[k]);
  providerConfig = {};
  Object.keys(defaults).forEach((k) => delete defaults[k]);
  loaded = false;
}

export default {
  load,
  get,
  getString,
  getInt,
  getBool,
  set,
  setDefault,
  setDefaults,
  getAll,
  reset,
};
