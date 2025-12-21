/**
 * Upload handlers for ESA Edge Function
 */

import {
    jsonResponse,
    errorResponse,
    signUploadPayload,
    verifyUploadToken,
    MAX_FILE_SIZE,
    CHUNK_SIZE,
} from "../utils.js";
import { createS3Client } from "../s3.js";

/**
 * 初始化上传：验证文件大小，生成 fileId 和 uploadToken
 * POST /api/upload/start
 */
export async function handleUploadStart(request) {
    // Get file size from request
    const body = await request.json().catch(() => ({}));
    const { fileSize } = body;

    // Validate file size
    if (!fileSize || typeof fileSize !== "number" || fileSize <= 0) {
        return errorResponse("Missing or invalid fileSize", 400);
    }

    if (fileSize > MAX_FILE_SIZE) {
        return errorResponse(
            `File size exceeds limit. Maximum allowed: ${MAX_FILE_SIZE} bytes (20GB)`,
            413
        );
    }

    // Calculate expected total chunks
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    // 生成文件 ID（用于标识这次上传）
    const currentHourTimestamp = Math.floor(Date.now() / 3600000) * 3600;
    const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(10)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const fileId = `${currentHourTimestamp}-${randomPart}`;

    // 生成上传 token（包含 totalChunks 用于验证后续请求）
    const uploadToken = await signUploadPayload(fileId, totalChunks);

    return jsonResponse({ fileId, uploadToken, totalChunks });
}

/**
 * 获取分片上传 URL
 * POST /api/upload/chunk
 */
export async function handleUploadChunk(request) {
    const { fileId, chunkIndex, chunkSize } = await request.json();
    const token = request.headers.get("X-Upload-Token");

    if (!fileId || chunkIndex === undefined || !chunkSize) {
        return errorResponse("Missing fileId, chunkIndex or chunkSize", 400);
    }

    // 验证上传 token 并获取 totalChunks
    const tokenResult = await verifyUploadToken(fileId, token);
    if (!tokenResult.valid) {
        return errorResponse("Unauthorized: Invalid upload token", 403);
    }

    // 验证 chunkIndex 不超过允许的范围
    if (chunkIndex < 0 || chunkIndex >= tokenResult.totalChunks) {
        return errorResponse(
            `Invalid chunkIndex: ${chunkIndex}. Maximum allowed: ${tokenResult.totalChunks - 1}`,
            400
        );
    }

    // 生成 S3 对象 key
    const s3Key = `${fileId}/chunk_${chunkIndex}`;

    // 生成预签名上传 URL
    const s3Client = await createS3Client();
    const uploadUrl = await s3Client.getSignedUrl(s3Key, "PUT", 3600);

    return jsonResponse({
        uploadUrl,
        s3Key,
        chunkIndex,
    });
}

/**
 * 完成分片上传（前端上传完成后调用）
 * PUT /api/upload/chunk
 *
 * 注意：使用 S3 预签名 URL 上传时，PUT 完成即代表上传成功
 * 此端点用于前端报告上传完成
 */
export async function handleUploadChunkComplete(request) {
    const { fileId, chunkIndex, s3Key } = await request.json();
    const token = request.headers.get("X-Upload-Token");

    if (!fileId || chunkIndex === undefined || !s3Key) {
        return errorResponse("Missing required parameters", 400);
    }

    const tokenResult = await verifyUploadToken(fileId, token);
    if (!tokenResult.valid) {
        return errorResponse("Unauthorized: Invalid upload token", 403);
    }

    // S3 PUT 完成即上传成功，无需额外操作
    return jsonResponse({ success: true, chunkIndex, s3Key });
}

/**
 * 完成上传：保存文件元数据到 S3
 * POST /api/upload/complete
 */
export async function handleUploadComplete(request) {
    const { fileId, metadata, chunks } = await request.json();
    const token = request.headers.get("X-Upload-Token");

    if (!fileId || !metadata) {
        return errorResponse("Missing fileId or metadata", 400);
    }

    if (!chunks || !Array.isArray(chunks)) {
        return errorResponse("Missing chunks", 400);
    }

    // 验证上传 token 并获取 totalChunks
    const tokenResult = await verifyUploadToken(fileId, token);
    if (!tokenResult.valid) {
        return errorResponse("Unauthorized: Invalid upload token", 403);
    }

    // 验证提交的 chunk 数量等于预期
    if (chunks.length !== tokenResult.totalChunks) {
        return errorResponse(
            `Invalid chunk count: got ${chunks.length}, expected ${tokenResult.totalChunks} (from token)`,
            400
        );
    }

    // 验证 chunk 数量是否匹配 metadata
    if (chunks.length !== metadata.totalChunks) {
        return errorResponse(
            `Chunk count mismatch: metadata.totalChunks=${metadata.totalChunks}, chunks.length=${chunks.length}`,
            400
        );
    }

    // 保存元数据到 S3
    const fullMetadata = {
        ...metadata,
        chunks: chunks.sort((a, b) => a.index - b.index),
    };

    const s3Client = await createS3Client();
    const metadataKey = `${fileId}/metadata.json`;
    await s3Client.putObject(
        metadataKey,
        JSON.stringify(fullMetadata),
        "application/json"
    );

    return jsonResponse({ success: true, fileId });
}
