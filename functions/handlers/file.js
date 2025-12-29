/**
 * File handlers for ESA Edge Function
 */

import { errorResponse, getMetadataKV, getMetadataKey } from "../utils.js";
import { createStorageBackend } from "../storage/storage.js";

/**
 * 获取文件元数据
 * GET /api/file/:id
 */
export async function handleGetFile(c) {
    const fileId = c.req.param('id')
    if (!fileId) {
        return errorResponse(c, "Missing fileId", 400);
    }

    // 从 KV 获取元数据
    const kv = getMetadataKV();
    const metadata = await kv.get(getMetadataKey(fileId), { type: "json" });
    if (!metadata) {
        return errorResponse(c, "File not found", 404);
    }

    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ metadata });
}

/**
 * 获取 chunk 信息的通用辅助函数
 * @returns {{ chunk: object, metadata: object } | null} 返回 chunk 和 metadata，或 null
 */
async function getChunkInfo(fileId, chunkIndex) {
    const kv = getMetadataKV();
    const metadata = await kv.get(getMetadataKey(fileId), { type: "json" });
    if (!metadata) {
        return null;
    }
    const chunkIds = metadata.chunkIds || [];
    const chunk = chunkIds.find((c) => c.index === chunkIndex);
    if (!chunk) {
        return null;
    }
    return { chunk, metadata };
}

/**
 * 获取单个 chunk（统一端点）
 * GET /api/file/:id/chunk/:chunkIndex
 * 
 * - 直链模式：返回 302 重定向到实际下载 URL
 * - 转发模式：流式返回内容
 */
export async function handleGetChunk(c) {
    const fileId = c.req.param('id');
    const chunkIndex = parseInt(c.req.param('chunkIndex'));

    if (!fileId || isNaN(chunkIndex)) {
        return errorResponse(c, "Missing fileId or chunkIndex", 400);
    }

    const chunkInfo = await getChunkInfo(fileId, chunkIndex);
    if (!chunkInfo || !chunkInfo.chunk) {
        return errorResponse(c, `Chunk ${chunkIndex} not found`, 404);
    }
    const { chunk } = chunkInfo;
    const storage = await createStorageBackend();
    if (storage.supportsDirectUrl) {
        // 直链模式：302 重定向
        const downloadUrl = await storage.getDownloadUrl(chunk.fileId);
        return c.redirect(downloadUrl)
    }

    // 转发模式：流式返回内容
    const response = await storage.streamFile(chunk.fileId);
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    // set cache
    const ONE_YEAR_IN_SECONDS = 31536000;
    headers.set("Cache-Control", `public, max-age=${ONE_YEAR_IN_SECONDS}`);
    headers.set("Expires", new Date(Date.now() + ONE_YEAR_IN_SECONDS * 1000).toUTCString());
    return new Response(response.body, { status: response.status, headers })
}
