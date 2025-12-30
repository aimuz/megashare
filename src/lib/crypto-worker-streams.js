/**
 * 使用 Worker 的流式加密器
 * 在独立线程处理加密，避免阻塞 UI
 */

import { getCryptoWorker } from "./worker-bridge.js";
import { appendBuffer } from "./utils.js";

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

    try {
      // 初始化密钥（只需一次）
      await this._initMasterKey();

      let pendingBuffer = new Uint8Array(0);
      let blockIndex = 0;
      let totalRead = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (value) {
          totalRead += value.byteLength;
          onProgress?.(value.byteLength, totalRead);
          pendingBuffer = appendBuffer(pendingBuffer, value);
        }

        // 处理完整的加密块
        while (
          pendingBuffer.length >= this.blockSize ||
          (done && pendingBuffer.length > 0)
        ) {
          const isLastBlock = done && pendingBuffer.length < this.blockSize;
          const blockEnd = isLastBlock ? pendingBuffer.length : this.blockSize;
          // Use subarray to avoid copying
          const blockData = pendingBuffer.subarray(0, blockEnd);
          pendingBuffer = pendingBuffer.subarray(blockEnd);

          // 加密（使用 keyId）
          const encryptedBlock = await this.worker.encryptBlock(
            this.keyId,
            blockData,
            this.baseIv,
            this.globalBlockOffset,
            blockIndex,
          );

          encryptedBlocks.push(encryptedBlock);
          onEncrypted?.(encryptedBlock);
          blockIndex++;

          if (isLastBlock) break;
        }

        if (done) break;
      }

      // 在 Worker 中计算哈希（避免阻塞主线程）
      const encryptedBlob = new Blob(encryptedBlocks);
      const encryptedData = await encryptedBlob.arrayBuffer();
      const contentHash = await this.worker.computeHash(encryptedData);

      return {
        data: encryptedData,
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

      let pendingBuffer = new Uint8Array(0);
      let blockIndex = 0;
      let totalReceived = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (value) {
          totalReceived += value.byteLength;
          onProgress?.(value.byteLength, totalReceived);
          pendingBuffer = appendBuffer(pendingBuffer, value);
        }

        // 处理完整的加密块
        while (
          pendingBuffer.length >= this.encryptedBlockSizeWithTag ||
          (done && pendingBuffer.length > 0)
        ) {
          const isLastBlock =
            done && pendingBuffer.length < this.encryptedBlockSizeWithTag;
          const blockEnd = isLastBlock
            ? pendingBuffer.length
            : this.encryptedBlockSizeWithTag;
          // Use subarray to avoid copying
          const blockData = pendingBuffer.subarray(0, blockEnd);
          pendingBuffer = pendingBuffer.subarray(blockEnd);

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
