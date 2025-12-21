/**
 * ESA Edge Function 工具库
 * 提供 HMAC 签名等工具函数
 */

// --- Constants ---
export const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20GB
export const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

// --- KV Config Namespace ---
const CONFIG_NAMESPACE = "megashare-config";

function getConfigKV() {
    return new EdgeKV({ namespace: CONFIG_NAMESPACE });
}

// --- Config Helper ---
export async function getConfig(key) {
    const kv = getConfigKV();
    return await kv.get(key, { type: "text" });
}

// --- Response Helpers ---

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Upload-Token",
        },
    });
}

export function errorResponse(message, status = 500) {
    return jsonResponse({ error: message }, status);
}

export function handleCORS() {
    return new Response(null, {
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Upload-Token",
        },
    });
}

// --- Security Helpers ---

async function getSecretKey() {
    const secret = (await getConfig("UPLOAD_SECRET")) || "default-dev-secret-please-change";
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
 * Sign upload payload (fileId + totalChunks)
 * Returns: base64url(payload) + "." + base64url(signature)
 */
export async function signUploadPayload(fileId, totalChunks) {
    const key = await getSecretKey();
    const enc = new TextEncoder();

    // Create payload: fileId:totalChunks
    const payload = `${fileId}:${totalChunks}`;
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
        const [tokenFileId, totalChunksStr] = payload.split(":");

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
            totalChunks: parseInt(totalChunksStr, 10),
        };
    } catch (e) {
        return { valid: false };
    }
}
