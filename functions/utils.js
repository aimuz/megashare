/**
 * ESA Edge Function 工具库
 * 提供 KV 存储访问、HMAC 签名等工具函数
 */

import { getKV } from "./kv/kv.js";
import config from "./config/config.js";

// --- Config Helpers ---
export function getMaxFileSize() {
    return config.getInt("MAX_FILE_SIZE", 20 * 1024 * 1024 * 1024); // 20GB
}

export function getChunkSize() {
    return config.getInt("CHUNK_SIZE", 128 * 1024 * 1024); // 128MB
}

// --- KV Namespaces ---
const METADATA_NAMESPACE = "megashare-metadata";

export function getMetadataKV() {
    return getKV(METADATA_NAMESPACE);
}

// --- KV Key Helper ---
// Base62 字符集（与 upload.js 保持一致）
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 解码 base62 字符串为数字
function decodeBase62(str) {
    let num = 0n;
    for (const c of str) {
        const idx = BASE62.indexOf(c);
        if (idx === -1) return null; // 无效字符
        num = num * 62n + BigInt(idx);
    }
    return Number(num);
}

/**
 * 将 fileId 转换为 metadata key
 * 新格式 fileId: "1Zc3-a3Bx9ZkP" → key: "metadata:1734857999-a3Bx9ZkP"
 * 旧格式 fileId: "1734857999-xxxx" → key: "metadata:1734857999-xxxx" (兼容)
 */
export function getMetadataKey(fileId) {
    const [firstPart, randomPart] = fileId.split("-");

    // 检测是否为新格式（4字符 base62 小时）
    if (firstPart.length === 4 && randomPart) {
        const hour = decodeBase62(firstPart);
        if (hour !== null) {
            const timestamp = hour * 3600; // 小时 → 秒
            return `metadata:${timestamp}-${randomPart}`;
        }
    }

    // 旧格式或解析失败，直接使用原 fileId
    return `metadata:${fileId}`;
}

// --- Response Helpers ---
export function errorResponse(c, message, status = 500) {
    return c.json({ error: message }, status);
}

// --- Security Helpers ---

async function getSecretKey() {
    const secret = config.get("UPLOAD_SECRET");
    if (!secret) {
        throw new Error("Required configuration UPLOAD_SECRET is missing.");
    }
    const enc = new TextEncoder();
    return await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
    );
}

/**
 * Sign upload payload (fileId + folderId + totalChunks)
 * Returns: base64url(payload) + "." + base64url(signature)
 */
export async function signUploadPayload(fileId, folderId, totalChunks) {
    const key = await getSecretKey();
    const enc = new TextEncoder();

    // Create payload: fileId:folderId:totalChunks
    const payload = `${fileId}:${folderId}:${totalChunks}`;
    const payloadB64 = btoa(payload)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

    // Sign the payload
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

    return `${payloadB64}.${sigB64}`;
}

/**
 * Verify upload token and extract payload
 * Returns: { valid: boolean, fileId?: string, totalChunks?: number }
 */
export async function verifyUploadToken(fileId, token) {
    if (!token) return { valid: false };

    try {
        const key = await getSecretKey();
        const enc = new TextEncoder();

        // Split token into payload and signature
        const [payloadB64, sigB64] = token.split(".");
        if (!payloadB64 || !sigB64) return { valid: false };

        // Decode payload
        const payload = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
        const [tokenFileId, tokenFolderId, totalChunksStr] = payload.split(":");

        // Verify fileId matches
        if (tokenFileId !== fileId) return { valid: false };

        // Verify signature
        const signature = Uint8Array.from(
            atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0)
        );

        const isValid = await crypto.subtle.verify(
            "HMAC",
            key,
            signature,
            enc.encode(payload)
        );

        if (!isValid) return { valid: false };

        return {
            valid: true,
            fileId: tokenFileId,
            folderId: tokenFolderId,
            totalChunks: parseInt(totalChunksStr, 10),
        };
    } catch (e) {
        return { valid: false };
    }
}

// --- Retry Helper ---

/**
 * 带指数退避的重试函数
 * @param {Function} fn - 要执行的异步函数
 * @param {Object} options - 配置选项
 * @param {number} options.maxRetries - 最大重试次数，默认 3
 * @param {number} options.baseDelayMs - 基础延迟毫秒，默认 100
 * @returns {Promise<any>} fn 的返回值
 * @throws {Error} 重试耗尽后抛出最后一次错误
 */
export async function retry(fn, { maxRetries = 3, baseDelayMs = 100 } = {}) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (i < maxRetries - 1) {
                await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i)));
            }
        }
    }
    throw lastError;
}
