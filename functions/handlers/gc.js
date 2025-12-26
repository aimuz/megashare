/**
 * GC (Garbage Collection) handler for ESA Edge Function
 * 扫描并清理过期文件
 */

import {
    errorResponse,
    getMetadataKV,
    getConfig,
} from "../utils.js";
import { createStorageBackend } from "../storage/storage.js";

// 默认过期天数
const DEFAULT_EXPIRY_DAYS = 7;

/**
 * 验证 GC 请求的 Token
 * @param {Request} request
 * @returns {Promise<{valid: boolean, error?: string, status?: number}>}
 */
async function verifyGCToken(request) {
    const authHeader = request.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return { valid: false, error: "Missing or invalid Authorization header", status: 401 };
    }

    const token = authHeader.slice(7); // 移除 "Bearer " 前缀
    const gcSecret = getConfig("GC_SECRET");

    if (!gcSecret) {
        return { valid: false, error: "GC_SECRET not configured", status: 500 };
    }

    if (token !== gcSecret) {
        return { valid: false, error: "Invalid GC token", status: 403 };
    }

    return { valid: true };
}

/**
 * 从 fileId 解析创建时间戳
 * fileId 格式: {hourTimestamp}-{randomHex}
 * @param {string} fileId
 * @returns {number|null} 时间戳（毫秒），解析失败返回 null
 */
function parseFileIdTimestamp(fileId) {
    if (!fileId || typeof fileId !== "string") return null;
    const parts = fileId.split("-");
    if (parts.length < 2) return null;
    const ts = parseInt(parts[0], 10);
    return isNaN(ts) ? null : ts * 1000; // hourTimestamp 是秒，转为毫秒
}

/**
 * GC 接口：扫描并清理过期文件
 * POST /api/gc
 * 
 * Headers:
 *   Authorization: Bearer <GC_SECRET>
 * 
 * Response:
 *   { scanned: number, deleted: number, errors: string[] }
 */
export async function handleGC(c) {
    // 1. 验证 Token
    const auth = await verifyGCToken(c.req);
    if (!auth.valid) {
        return errorResponse(c, auth.error, auth.status)
    }

    // 2. 获取过期配置
    const expiryDaysStr = getConfig("GC_EXPIRY_DAYS");
    const expiryDays = expiryDaysStr ? parseInt(expiryDaysStr, 10) : DEFAULT_EXPIRY_DAYS;
    const expiryThreshold = Date.now() - expiryDays * 24 * 60 * 60 * 1000;

    // 3. 扫描 KV 中的所有 metadata
    const kv = getMetadataKV();
    const errors = [];
    let scanned = 0;
    let deleted = 0;

    try {
        // 获取存储后端
        const storage = await createStorageBackend();

        // 列出所有 metadata key
        const listResult = await kv.list({ prefix: "metadata:" });
        const keys = listResult.keys || [];

        for (const keyInfo of keys) {
            scanned++;
            const key = keyInfo.name;
            const fileId = key.replace("metadata:", "");

            try {
                // 获取 metadata
                const metadataStr = await kv.get(key, { type: "text" });
                if (!metadataStr) continue;

                const metadata = JSON.parse(metadataStr);

                // 判断是否过期：优先使用 metadata.createdAt，否则从 fileId 解析
                let createdAt = metadata.createdAt;
                if (!createdAt) {
                    createdAt = parseFileIdTimestamp(fileId);
                }

                if (!createdAt || createdAt > expiryThreshold) {
                    // 未过期或无法判断，跳过
                    continue;
                }

                // 文件已过期，删除存储后端文件和 KV 元数据
                await deleteStoredFile(fileId, metadata, storage);
                await kv.delete(key);
                deleted++;
            } catch (err) {
                errors.push(`Failed to process ${fileId}: ${err.message}`);
            }
        }
    } catch (err) {
        return errorResponse(c, `Failed to list metadata: ${err.message}`, 500);
    }

    return c.json({
        scanned,
        deleted,
        expiryDays,
        expiryThreshold: new Date(expiryThreshold).toISOString(),
        errors: errors.length > 0 ? errors : undefined,
    });
}

/**
 * 删除存储后端上的文件（文件夹及其所有分片）
 * @param {string} fileId
 * @param {object} metadata
 * @param {import('../storage/storage.js').StorageBackend} storage
 */
async function deleteStoredFile(fileId, metadata, storage) {
    if (storage.supportsFolderDelete) {
        // 后端支持删除文件夹时递归删除内容
        const folderId = metadata.folderId;
        if (folderId) {
            await storage.deleteFile(folderId);
        }
    } else {
        // 后端不支持文件夹删除，需逐个删除分片（如 S3）
        const chunkIds = metadata.chunkIds || [];
        for (const chunk of chunkIds) {
            if (chunk.fileId) {
                await storage.deleteFile(chunk.fileId);
            }
        }
    }
}
