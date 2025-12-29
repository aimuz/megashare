/**
 * Storage Backend Abstraction Layer
 * 提供统一的存储接口，支持多种后端实现
 */

import { getConfig } from "../utils.js";

/**
 * @typedef {Object} CreateFolderResult
 * @property {string} folderId - 创建的文件夹 ID
 */

/**
 * @typedef {Object} UploadSpec
 * @property {string} url - 上传 URL
 * @property {string} method - HTTP 方法 (PUT/POST)
 * @property {Object<string, string>} [headers] - 需要设置的请求头
 * @property {'raw'|'form-data'} [bodyType] - 请求体类型，默认 'raw'
 * @property {string} [fieldName] - form-data 时的字段名
 */

/**
 * @typedef {Object} CreateFileResult
 * @property {string} fileId - 文件 ID
 * @property {string} uploadId - 上传会话 ID
 * @property {UploadSpec} [uploadSpec] - 上传规格（直传模式）
 * @property {boolean} exist - 文件是否已存在（秒传）
 * @property {boolean} [rapidUpload] - 是否为秒传
 */

/**
 * @typedef {Object} ListItem
 * @property {string} fileId - 文件/文件夹 ID
 * @property {string} name - 名称
 * @property {string} type - 类型: 'file' | 'folder'
 */

/**
 * @typedef {Object} ListFilesResult
 * @property {ListItem[]} items - 文件/文件夹列表
 */

/**
 * Storage Backend Interface
 * 所有存储后端必须实现此接口
 *
 * @typedef {Object} StorageBackend
 * @property {boolean} supportsDirectUrl - 是否支持直链下载
 * @property {boolean} supportsDirectUpload - 是否支持直传上传（客户端直接上传到存储），否则需代理上传
 * @property {boolean} supportsFolderDelete - 是否支持删除文件夹时递归删除内容
 * @property {(name: string) => Promise<CreateFolderResult>} createFolder - 在根目录创建文件夹
 * @property {(parentId: string, name: string, size: number, hash?: string) => Promise<CreateFileResult>} createFileAndGetUploadUrl - 创建文件并获取上传 URL
 * @property {(fileId: string, uploadId: string, hash?: string) => Promise<void>} completeUpload - 完成上传
 * @property {(parentId: string, name: string, data: ArrayBuffer|ReadableStream, hash?: string) => Promise<{fileId: string}>} uploadFile - 代理上传文件（用于不支持直传的后端）
 * @property {(fileId: string) => Promise<string|null>} getDownloadUrl - 获取下载直链
 * @property {(fileId: string) => Promise<Response>} streamFile - 流式获取文件内容
 * @property {(fileIds: string|string[]) => Promise<void>} deleteFile - 删除文件/文件夹
 */

// --- 插件注册系统 ---

/** @type {Object<string, () => Promise<StorageBackend>>} */
const backends = {};

/** @type {StorageBackend|null} */
let cachedBackend = null;

/**
 * 注册存储后端
 * @param {string} name - 后端名称（与 STORAGE_BACKEND 配置值对应）
 * @param {() => Promise<StorageBackend>} factory - 创建后端实例的工厂函数
 */
export function registerBackend(name, factory) {
    backends[name] = factory;
}

/**
 * 创建存储后端实例
 * 根据配置选择对应的后端实现
 *
 * @returns {Promise<StorageBackend>}
 */
export async function createStorageBackend() {
    if (cachedBackend) {
        return cachedBackend;
    }

    const availableBackends = Object.keys(backends);
    if (availableBackends.length == 0) {
        throw new Error("No storage backend registered");
    }

    const backendType = getConfig("STORAGE_BACKEND") || availableBackends[0];
    console.debug(`Using storage backend: ${backendType}`);
    const factory = backends[backendType];
    if (!factory) {
        const available = Object.keys(backends).join(", ") || "none";
        throw new Error(`Unknown storage backend: ${backendType}. Available: ${available}`);
    }

    cachedBackend = await factory();
    return cachedBackend;
}

/**
 * 清除缓存的后端实例（用于测试或配置变更）
 */
export function clearBackendCache() {
    cachedBackend = null;
}
