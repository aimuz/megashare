/**
 * 使用 Worker 的流式加密器
 * 在独立线程处理加密，避免阻塞 UI
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getCryptoWorker } from "./worker-bridge.js";
import { BufferAccumulator } from "./utils.js";

export class WorkerStreamEncryptor {
  constructor(masterKey, baseIv, chunkIndex, chunkSize, blockSize) {
    this.masterKey = masterKey;
    this.baseIv = baseIv;
    this.chunkIndex = chunkIndex;
    this.blockSize = blockSize;
    this.blocksPerChunk = Math.ceil(chunkSize / blockSize);
    this.globalBlockOffset = chunkIndex * this.blocksPerChunk;
    this.worker = getCryptoWorker();
    this.masterKeyInitialized = false;
    // 生成唯一 keyId
    this.keyId = crypto.randomUUID();
  }

  async _initMasterKey() {
    if (!this.masterKeyInitialized) {
      const masterKeyRaw = await crypto.subtle.exportKey("raw", this.masterKey);
      await this.worker.setMasterKey(this.keyId, masterKeyRaw);
      this.masterKeyInitialized = true;
    }
  }

  async _releaseKey() {
    if (this.masterKeyInitialized) {
      await this.worker.releaseKey(this.keyId);
    }
  }

  async processStream(fileSlice, onEncrypted, onProgress) {
    const stream = fileSlice.stream();
    const reader = stream.getReader();

    // 用于累积加密块（边加密边累积，用于创建 Blob）
    const encryptedBlocks = [];

    // 流式哈希计算器
    const hasher = sha256.create();

    try {
      // 初始化密钥（只需一次）
      await this._initMasterKey();

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
          const blockData = isLastBlock ? buffer.consumeAll() : buffer.consume(this.blockSize);

          // 加密（使用 keyId）
          const encryptedBlock = await this.worker.encryptBlock(
            this.keyId,
            blockData,
            this.baseIv,
            this.globalBlockOffset,
            blockIndex,
          );

          // 增量计算哈希
          hasher.update(new Uint8Array(encryptedBlock));
          totalEncryptedSize += encryptedBlock.byteLength;

          encryptedBlocks.push(encryptedBlock);
          onEncrypted?.(encryptedBlock);
          blockIndex++;

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
    } finally {
      // 确保释放资源
      reader.releaseLock();
      await this._releaseKey();
    }
  }
}

/**
 * 使用 Worker 的流式解密器
 */
export class WorkerStreamDecryptor {
  constructor(masterKey, baseIv, chunkIndex, chunkSize, blockSize) {
    this.masterKey = masterKey;
    this.baseIv = baseIv;
    this.chunkIndex = chunkIndex;
    this.blockSize = blockSize;
    this.encryptedBlockSizeWithTag = blockSize + 16;
    this.blocksPerChunk = Math.ceil(chunkSize / blockSize);
    this.globalBlockOffset = chunkIndex * this.blocksPerChunk;
    this.worker = getCryptoWorker();
    this.masterKeyInitialized = false;
    // 生成唯一 keyId
    this.keyId = crypto.randomUUID();
  }

  async _initMasterKey() {
    if (!this.masterKeyInitialized) {
      const masterKeyRaw = await crypto.subtle.exportKey("raw", this.masterKey);
      await this.worker.setMasterKey(this.keyId, masterKeyRaw);
      this.masterKeyInitialized = true;
    }
  }

  async _releaseKey() {
    if (this.masterKeyInitialized) {
      await this.worker.releaseKey(this.keyId);
    }
  }

  async processStream(url, onDecrypted, onProgress) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`下载失败: ${res.status}`);
    }

    const reader = res.body.getReader();

    try {
      // 初始化密钥（只需一次）
      await this._initMasterKey();

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
        while (buffer.length >= this.encryptedBlockSizeWithTag || (done && buffer.length > 0)) {
          const isLastBlock = done && buffer.length < this.encryptedBlockSizeWithTag;
          const blockData = isLastBlock
            ? buffer.consumeAll()
            : buffer.consume(this.encryptedBlockSizeWithTag);

          // 解密（使用 keyId）
          const decrypted = await this.worker.decryptBlock(
            this.keyId,
            blockData,
            this.baseIv,
            this.globalBlockOffset,
            blockIndex,
          );

          await onDecrypted(decrypted);
          blockIndex++;

          if (isLastBlock) break;
        }

        if (done) break;
      }
    } finally {
      // 确保释放资源
      reader.releaseLock();
      await this._releaseKey();
    }
  }
}
