/**
 * Crypto Worker - 在独立线程处理加密/解密操作
 * 避免阻塞主线程 UI
 *
 * 优化：
 * 1. 缓存 masterKey，避免重复传输和导入
 * 2. 支持多个并发会话（使用 keyId 区分）
 */

// 缓存的主密钥 Map（keyId -> CryptoKey）
const keyCache = new Map();

/**
 * 为特定块索引派生 IV
 */
function getChunkIV(baseIv, index) {
  const iv = new Uint8Array(baseIv);
  const view = new DataView(iv.buffer);
  const lastUint32 = view.getUint32(8, false);
  view.setUint32(8, lastUint32 + index, false);
  return iv;
}

/**
 * 加密单个块
 */
async function encryptBlock(blockData, masterKey, baseIv, globalIndex) {
  const iv = getChunkIV(baseIv, globalIndex);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    masterKey,
    blockData,
  );
  return new Uint8Array(encrypted);
}

/**
 * 解密单个块
 */
async function decryptBlock(blockData, masterKey, baseIv, globalIndex) {
  const iv = getChunkIV(baseIv, globalIndex);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    masterKey,
    blockData,
  );
  return new Uint8Array(decrypted);
}

/**
 * 处理加密流
 */
async function processEncryptStream(data) {
  const { blockData, baseIv, globalBlockOffset, blockIndex, keyId } = data;

  // 使用指定 keyId 的密钥
  const masterKey = keyCache.get(keyId);
  if (!masterKey) {
    throw new Error(`Master key not found for keyId: ${keyId}. Call setMasterKey first.`);
  }

  const globalIndex = globalBlockOffset + blockIndex;
  const encrypted = await encryptBlock(
    blockData,
    masterKey,
    baseIv,
    globalIndex,
  );

  // 不使用 transfer，使用结构化克隆
  return {
    type: "encrypted-block",
    blockIndex,
    data: encrypted,
  };
}

/**
 * 处理解密流
 */
async function processDecryptStream(data) {
  const { blockData, baseIv, globalBlockOffset, blockIndex, keyId } = data;

  // 使用指定 keyId 的密钥
  const masterKey = keyCache.get(keyId);
  if (!masterKey) {
    throw new Error(`Master key not found for keyId: ${keyId}. Call setMasterKey first.`);
  }

  const globalIndex = globalBlockOffset + blockIndex;
  const decrypted = await decryptBlock(
    blockData,
    masterKey,
    baseIv,
    globalIndex,
  );

  // 不使用 transfer，使用结构化克隆
  return {
    type: "decrypted-block",
    blockIndex,
    data: decrypted,
  };
}

/**
 * 生成主密钥
 */
async function generateMasterKey() {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const exported = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(exported)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * 计算数据哈希
 */
async function computeHash(data) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 加密敏感元数据
 */
async function encryptMetadata(data) {
  const { masterKeyRaw, baseIv, sensitiveMeta } = data;

  const masterKey = await crypto.subtle.importKey(
    "raw",
    masterKeyRaw,
    "AES-GCM",
    true,
    ["encrypt"],
  );

  const jsonStr = JSON.stringify(sensitiveMeta);
  const encoded = new TextEncoder().encode(jsonStr);
  const metaIv = getChunkIV(baseIv, 0xffffffff);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: metaIv },
    masterKey,
    encoded,
  );

  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// 消息处理器
self.addEventListener("message", async (event) => {
  const { id, type, data } = event.data;

  try {
    let result;

    switch (type) {
      case "set-master-key":
        // 缓存主密钥（支持多个并发会话）
        const { keyId, masterKeyRaw } = data;
        const masterKey = await crypto.subtle.importKey(
          "raw",
          masterKeyRaw,
          "AES-GCM",
          true,
          ["encrypt", "decrypt"],
        );
        keyCache.set(keyId, masterKey);
        result = { success: true };
        break;

      case "release-key":
        // 释放密钥缓存
        keyCache.delete(data.keyId);
        result = { success: true };
        break;

      case "generate-key":
        result = await generateMasterKey();
        break;

      case "compute-hash":
        result = await computeHash(data);
        break;

      case "encrypt-block":
        result = await processEncryptStream(data);
        break;

      case "decrypt-block":
        result = await processDecryptStream(data);
        break;

      case "encrypt-metadata":
        result = await encryptMetadata(data);
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    // 不使用 transferables，使用结构化克隆
    self.postMessage({
      id,
      type: "success",
      result,
    });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      error: error.message,
    });
  }
});

// Worker 就绪通知
self.postMessage({ type: "ready" });
