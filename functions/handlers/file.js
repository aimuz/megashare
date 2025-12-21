/**
 * File handlers for ESA Edge Function
 */

import { jsonResponse, errorResponse } from "../utils.js";
import { createS3Client } from "../s3.js";

/**
 * 将 AWS SDK 的 stream 转为字符串（使用 Web API）
 */
async function streamToString(stream) {
    // AWS SDK v3 的 Body 可能有 transformToString 方法
    if (typeof stream.transformToString === "function") {
        return await stream.transformToString();
    }

    // 如果是 ReadableStream，使用 Response 来读取
    if (stream instanceof ReadableStream) {
        const response = new Response(stream);
        return await response.text();
    }

    // 如果是 async iterable，手动收集
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }

    // 合并 Uint8Array 并转为字符串
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(result);
}

/**
 * 获取文件元数据
 * GET /api/file/:id
 */
export async function handleGetFile(fileId) {
    if (!fileId) {
        return errorResponse("Missing fileId", 400);
    }

    // 从 S3 获取元数据
    const s3Client = await createS3Client();
    const metadataKey = `${fileId}/metadata.json`;

    try {
        const stream = await s3Client.getObject(metadataKey);
        const metadataStr = await streamToString(stream);
        const metadata = JSON.parse(metadataStr);

        return new Response(
            JSON.stringify({
                metadata: metadata,
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=3600",
                },
            }
        );
    } catch (err) {
        return errorResponse(`File not found: ${err.message}`, 404);
    }
}

/**
 * 直接下载 chunk（代理模式，节省外网流量）
 * GET /api/file/:id/chunk/:chunkIndex/download
 */
export async function handleDownloadChunk(fileId, chunkIndex) {
    if (!fileId || isNaN(chunkIndex)) {
        return errorResponse("Missing fileId or chunkIndex", 400);
    }

    // 从 S3 获取元数据
    const s3Client = await createS3Client();
    const metadataKey = `${fileId}/metadata.json`;

    let metadata;
    try {
        const stream = await s3Client.getObject(metadataKey);
        const metadataStr = await streamToString(stream);
        metadata = JSON.parse(metadataStr);
    } catch (err) {
        return errorResponse(`File not found: ${err.message}`, 404);
    }

    const chunks = metadata.chunks || [];

    // 找到对应的 chunk
    const chunk = chunks.find((c) => c.index === chunkIndex);
    if (!chunk) {
        return errorResponse(`Chunk ${chunkIndex} not found`, 404);
    }

    // 使用预签名 URL 获取对象，避免处理 AWS SDK 复杂的流类型
    const signedUrl = await s3Client.getSignedUrl(chunk.s3Key, "GET", 3600);
    const s3Response = await fetch(signedUrl);
    return new Response(s3Response.body, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": s3Response.headers.get("Content-Length") || "",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
        },
    });
}
