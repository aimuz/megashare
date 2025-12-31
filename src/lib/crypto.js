/**
 * 加密相关工具函数
 */

import { BufferAccumulator, bytesToHex } from "./utils";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * 生成主密钥
 */
export async function generateMasterKey() {
  const key = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  return key;
}

export async function exportMasterKey(key) {
  const rawKey = await window.crypto.subtle.exportKey("raw", key);
  return encodeBase64(rawKey);
}

/**
 * 导入主密钥
 */
export async function importMasterKey(rawKey) {
  return await window.crypto.subtle.importKey("raw", rawKey, "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

export function encodeBase64(exported) {
  return btoa(String.fromCharCode(...new Uint8Array(exported)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function decodeBase64(base64Key) {
  const rawKey = Uint8Array.from(
    atob(base64Key.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  return rawKey;
}

/**
 * 计算数据哈希
 */
export async function hashData(dataStr) {
  const enc = new TextEncoder();
  const hashBuffer = await window.crypto.subtle.digest(
    "SHA-256",
    enc.encode(dataStr),
  );
  return encodeBase64(hashBuffer);
}

/**
 * 为特定块索引派生 IV
 */
export function getChunkIV(baseIv, index) {
  const iv = new Uint8Array(baseIv);
  const view = new DataView(iv.buffer);
  const lastUint32 = view.getUint32(8, false);
  view.setUint32(8, lastUint32 + index, false);
  return iv;
}

/**
 * 加密敏感元数据
 */
export async function encryptSensitiveMeta(masterKey, baseIv, sensitiveMeta) {
  const jsonStr = JSON.stringify(sensitiveMeta);
  const encoded = new TextEncoder().encode(jsonStr);
  const metaIv = getChunkIV(baseIv, 0xffffffff);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: metaIv },
    masterKey,
    encoded,
  );
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

/**
 * 解密敏感元数据
 */
export async function decryptSensitiveMeta(
  masterKeyStr,
  baseIv,
  encryptedMeta,
) {
  try {
    const masterKey = await importMasterKey(decodeBase64(masterKeyStr));
    const ivArray = new Uint8Array(baseIv);
    const metaIv = getChunkIV(ivArray, 0xffffffff);
    const encrypted = Uint8Array.from(atob(encryptedMeta), (c) =>
      c.charCodeAt(0),
    );
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: metaIv },
      masterKey,
      encrypted,
    );
    const jsonStr = new TextDecoder().decode(decrypted);
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to decrypt metadata:", e);
    return null;
  }
}

/**
 * 计算 SHA256 哈希
 */
export async function computeHash(data) {
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 加密单个块
 */
async function encryptBlock(blockData, masterKey, baseIv, globalIndex) {
  const iv = getChunkIV(baseIv, globalIndex);
  return await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    masterKey,
    blockData,
  );
}

/**
 * 解密单个块
 */
async function decryptBlock(blockData, masterKey, baseIv, globalIndex) {
  const iv = getChunkIV(baseIv, globalIndex);
  return await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    masterKey,
    blockData,
  );
}

/**
 * 流式加密
 */
export class StreamEncryptor {
  constructor(masterKey, baseIv, chunkIndex, chunkSize, blockSize) {
    this.masterKey = masterKey;
    this.baseIv = baseIv;
    this.chunkIndex = chunkIndex;
    this.blockSize = blockSize;
    this.blocksPerChunk = Math.ceil(chunkSize / blockSize);
    this.globalBlockOffset = chunkIndex * this.blocksPerChunk;
  }

  async processStream(fileSlice, onEncrypted, onProgress) {
    const stream = fileSlice.stream();
    const reader = stream.getReader();

    // 用于累积加密块（边加密边累积，用于创建 Blob）
    const encryptedBlocks = [];

    // 流式哈希计算器
    const hasher = sha256.create();

    const buffer = new BufferAccumulator();
    let blockIndex = 0;
    let totalRead = 0;
    let totalEncryptedSize = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        totalRead += value.byteLength;
        onProgress?.(value.byteLength, totalRead);
        buffer.append(value);
      }

      // 处理完整的加密块
      while (buffer.length >= this.blockSize || (done && buffer.length > 0)) {
        const isLastBlock = done && buffer.length < this.blockSize;
        const blockData = isLastBlock
          ? buffer.consumeAll()
          : buffer.consume(this.blockSize);

        const globalIndex = this.globalBlockOffset + blockIndex;
        try {
          const encryptedBlock = await encryptBlock(
            blockData,
            this.masterKey,
            this.baseIv,
            globalIndex,
          );

          // 增量计算哈希
          hasher.update(new Uint8Array(encryptedBlock));
          totalEncryptedSize += encryptedBlock.byteLength;

          encryptedBlocks.push(encryptedBlock);
          onEncrypted?.(encryptedBlock);
          blockIndex++;
        } catch (err) {
          throw new Error(
            `Failed to encrypt block ${blockIndex} (global ${globalIndex}): ${err.message}`,
          );
        }

        if (isLastBlock) break;
      }

      if (done) break;
    }

    // 完成哈希计算
    const contentHash = bytesToHex(hasher.digest());

    const encryptedBlob = new Blob(encryptedBlocks);

    // 释放 encryptedBlocks 引用，允许 GC 回收
    encryptedBlocks.length = 0;

    return {
      blob: encryptedBlob,
      size: totalEncryptedSize,
      hash: contentHash,
    };
  }
}

/**
 * 流式解密
 */
export class StreamDecryptor {
  constructor(masterKey, baseIv, chunkIndex, chunkSize, blockSize) {
    this.masterKey = masterKey;
    this.baseIv = baseIv;
    this.chunkIndex = chunkIndex;
    this.blockSize = blockSize;
    this.encryptedBlockSizeWithTag = blockSize + 16;
    this.blocksPerChunk = Math.ceil(chunkSize / blockSize);
    this.globalBlockOffset = chunkIndex * this.blocksPerChunk;
  }

  async processStream(url, onDecrypted, onProgress) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`下载失败: ${res.status}`);
    }

    const reader = res.body.getReader();
    const buffer = new BufferAccumulator();
    let blockIndex = 0;
    let totalReceived = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        totalReceived += value.byteLength;
        onProgress?.(value.byteLength, totalReceived);
        buffer.append(value);
      }

      // 处理完整的加密块
      while (
        buffer.length >= this.encryptedBlockSizeWithTag ||
        (done && buffer.length > 0)
      ) {
        const isLastBlock =
          done && buffer.length < this.encryptedBlockSizeWithTag;
        const blockData = isLastBlock
          ? buffer.consumeAll()
          : buffer.consume(this.encryptedBlockSizeWithTag);

        const globalIndex = this.globalBlockOffset + blockIndex;
        const decrypted = await decryptBlock(
          blockData,
          this.masterKey,
          this.baseIv,
          globalIndex,
        );

        await onDecrypted(decrypted);
        blockIndex++;

        if (isLastBlock) break;
      }

      if (done) break;
    }
  }
}

/**
 * 向后兼容：解密整块数据
 */
export async function decryptChunk(
  encryptedData,
  masterKey,
  baseIv,
  chunkIndex,
) {
  const iv = getChunkIV(baseIv, chunkIndex);
  try {
    return await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      masterKey,
      encryptedData,
    );
  } catch {
    throw new Error(
      `分块 ${chunkIndex} 解密失败。数据可能已被篡改或密钥错误。`,
    );
  }
}
