/**
 * Upload handlers for ESA Edge Function
 */

import {
    errorResponse,
    signUploadPayload,
    verifyUploadToken,
    getMetadataKV,
    getMetadataKey,
    MAX_FILE_SIZE,
    CHUNK_SIZE,
    retry,
} from "../utils.js";
import { createStorageBackend } from "../storage/storage.js";

// Base62 编码（URL 安全）
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 将字节数组编码为 base62 字符串
function toBase62Bytes(bytes) {
    let num = 0n;
    for (const b of bytes) num = (num << 8n) | BigInt(b);
    let result = "";
    while (num > 0n) {
        result = BASE62[Number(num % 62n)] + result;
        num = num / 62n;
    }
    return result.padStart(8, "0"); // 6字节 → 8个base62字符
}

// 将小时数编码为 4 字符 base62（保序，便于 GC 比较）
function encodeHour(hour) {
    let num = BigInt(hour);
    let result = "";
    while (num > 0n) {
        result = BASE62[Number(num % 62n)] + result;
        num = num / 62n;
    }
    return result.padStart(4, "0");
}

/**
 * 初始化上传：验证文件大小，在存储后端创建文件夹用于存放分片
 * POST /api/upload/start
 */
export async function handleUploadStart(c) {
    // Get file size from request
    const body = await c.req.json().catch(() => ({}));
    const { fileSize } = body;

    // Validate file size
    if (!fileSize || typeof fileSize !== "number" || fileSize <= 0) {
        return errorResponse(c, "Missing or invalid fileSize", 400);
    }

    if (fileSize > MAX_FILE_SIZE) {
        return errorResponse(c, `File size exceeds limit. Maximum allowed: ${MAX_FILE_SIZE} bytes (20GB)`, 413);
    }

    // Calculate expected total chunks
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    // 生成文件 ID（用于标识这次上传）
    // 小时数往后偏移1小时，确保文件至少存活24小时（最多25小时）
    const currentHour = Math.floor(Date.now() / 3600000) + 1;
    const hourPart = encodeHour(currentHour); // 4 字符 base62
    const randomPart = toBase62Bytes(crypto.getRandomValues(new Uint8Array(6))); // 8 字符 base62
    const fileId = `${hourPart}-${randomPart}`; // 例如: 1Zc3-a3Bx9ZkP (13字符)

    // 使用存储后端创建文件夹存放分片
    const storage = await createStorageBackend();
    let folderId = null;

    const result = await storage.createFolder(fileId);
    folderId = result.folderId;

    // 生成上传 token（包含 fileId + folderId + totalChunks，客户端无需知道 folderId）
    const uploadToken = await signUploadPayload(fileId, folderId, totalChunks);

    // 不返回 folderId 给客户端，它已嵌入 token 中
    return c.json({ fileId, uploadToken, totalChunks });
}

/**
 * 获取分片上传 URL（直传模式）
 * POST /api/upload/chunk
 * 
 * 仅在 supportsDirectUpload=true 时使用
 */
export async function handleUploadChunk(c) {
    const token = c.req.header("X-Upload-Token");
    const { fileId, chunkIndex, chunkSize, contentHash } = await c.req.json();
    if (!fileId || chunkIndex === undefined || !chunkSize) {
        return errorResponse(c, "Missing fileId, chunkIndex or chunkSize", 400);
    }

    // 验证上传 token 并获取 folderId 和 totalChunks
    const tokenResult = await verifyUploadToken(fileId, token);
    if (!tokenResult.valid) {
        return errorResponse(c, "Unauthorized: Invalid upload token", 403);
    }

    const { folderId, totalChunks } = tokenResult;

    // 验证 chunkIndex 不超过允许的范围
    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
        return errorResponse(c,
            `Invalid chunkIndex: ${chunkIndex}. Maximum allowed: ${totalChunks - 1}`,
            400
        );
    }

    const storage = await createStorageBackend();

    // 从 token 获取 folderId
    const chunkFileName = `chunk_${chunkIndex}`;
    const result = await storage.createFileAndGetUploadUrl(
        folderId,
        chunkFileName,
        chunkSize,
        contentHash || ""
    );

    if (!result.uploadSpec) {
        return errorResponse(c, "Failed to get upload spec from storage backend", 500);
    }

    return c.json({
        uploadSpec: result.uploadSpec,
        chunkFileId: result.fileId,
        uploadId: result.uploadId,
        chunkIndex,
    });
}

/**
 * 代理上传分片数据（代理模式）
 * POST /api/upload/chunk/data
 * 
 * 仅在 supportsDirectUpload=false 时使用
 * 客户端直接将数据 POST 到这个端点
 */
export async function handleUploadChunkData(c) {
    const fileId = c.req.header("X-File-Id");
    const chunkIndex = parseInt(c.req.header("X-Chunk-Index"), 10);
    const contentHash = c.req.header("X-Content-Hash") || "";
    const token = c.req.header("X-Upload-Token");

    if (!fileId || isNaN(chunkIndex)) {
        return errorResponse(c, "Missing X-File-Id or X-Chunk-Index header", 400);
    }

    // 验证上传 token 并获取 folderId
    const tokenResult = await verifyUploadToken(fileId, token);
    if (!tokenResult.valid) {
        return errorResponse(c, "Unauthorized: Invalid upload token", 403);
    }

    const { folderId, totalChunks } = tokenResult;

    // 验证 chunkIndex 范围
    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
        return errorResponse(c, `Invalid chunkIndex: ${chunkIndex}. Maximum allowed: ${totalChunks - 1}`, 400);
    }

    const storage = await createStorageBackend();

    // 读取请求体数据并代理上传
    const data = c.req.body;
    const chunkFileName = `chunk_${chunkIndex}`;

    const result = await storage.uploadFile(
        folderId,
        chunkFileName,
        data,
        contentHash
    );

    return c.json({
        chunkFileId: result.fileId,
        chunkIndex,
    });
}

/**
 * 完成分片上传（前端上传完成后调用）
 * PUT /api/upload/chunk
 */
export async function handleUploadChunkComplete(c) {
    const { fileId, chunkIndex, chunkFileId, uploadId, contentHash } =
        await c.req.json();
    const token = c.req.header("X-Upload-Token");

    if (!fileId || chunkIndex === undefined || !chunkFileId) {
        return errorResponse(c, "Missing required parameters", 400);
    }

    const tokenResult = await verifyUploadToken(fileId, token);
    if (!tokenResult.valid) {
        return errorResponse(c, "Unauthorized: Invalid upload token", 403);
    }

    // 通知存储后端上传完成（带重试）
    const storage = await createStorageBackend();
    try {
        await retry(() => storage.completeUpload(chunkFileId, uploadId, contentHash || ""));
    } catch (err) {
        console.error("completeUpload failed after retries:", err);
        return errorResponse(c, "Failed to complete chunk upload", 500);
    }

    return c.json({ success: true, chunkIndex });
}

/**
 * 完成上传：保存文件元数据和分片信息
 * POST /api/upload/complete
 */
export async function handleUploadComplete(c) {
    const { fileId, metadata, chunkIds } = await c.req.json();
    const token = c.req.header("X-Upload-Token");

    if (!fileId || !metadata) {
        return errorResponse(c, "Missing fileId or metadata", 400);
    }

    if (!chunkIds || !Array.isArray(chunkIds)) {
        return errorResponse(c, "Missing chunkIds", 400);
    }

    // 验证上传 token 并获取 folderId 和 totalChunks
    const tokenResult = await verifyUploadToken(fileId, token);
    if (!tokenResult.valid) {
        return errorResponse(c, "Unauthorized: Invalid upload token", 403);
    }

    const { folderId, totalChunks } = tokenResult;

    // 验证提交的 chunk 数量等于预期
    if (chunkIds.length !== totalChunks) {
        return errorResponse(c, `Invalid chunk count: got ${chunkIds.length}, expected ${totalChunks}`, 400);
    }

    // 验证 chunk 数量是否匹配
    if (chunkIds.length !== metadata.totalChunks) {
        return errorResponse(c, `Chunk count mismatch: expected ${metadata.totalChunks}, got ${chunkIds.length}`, 400);
    }

    // 保存元数据到 KV（从 token 获取 folderId）
    const fullMetadata = {
        ...metadata,
        chunkIds: chunkIds.sort((a, b) => a.index - b.index),
        folderId,
    };

    const kv = getMetadataKV();
    await kv.put(getMetadataKey(fileId), JSON.stringify(fullMetadata));

    return c.json({ success: true, fileId });
}
