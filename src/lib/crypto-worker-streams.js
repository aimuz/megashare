/**
 * 使用 Worker 的流式加密器
 * 在独立线程处理加密，避免阻塞 UI
 */

import { getCryptoWorker } from "./worker-bridge.js";

export class WorkerStreamEncryptor {
  constructor(masterKey, baseIv, chunkIndex, chunkSize, blockSize) {
    this.masterKey = masterKey;
    this.baseIv = baseIv;
    this.chunkIndex = chunkIndex;
    this.blockSize = blockSize;
    this.blocksPerChunk = Math.ceil(chunkSize / blockSize);
    this.globalBlockOffset = chunkIndex * this.blocksPerChunk;
    this.encryptedBlocks = [];
    this.worker = getCryptoWorker();
    this.masterKeyInitialized = false;
  }

  async _initMasterKey() {
    if (!this.masterKeyInitialized) {
      const masterKeyRaw = await crypto.subtle.exportKey("raw", this.masterKey);
      await this.worker.setMasterKey(masterKeyRaw);
      this.masterKeyInitialized = true;
    }
  }

  async processStream(fileSlice, onEncrypted, onProgress) {
    const stream = fileSlice.stream();
    const reader = stream.getReader();

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
        pendingBuffer = this._appendBuffer(pendingBuffer, value);
      }

      // 处理完整的加密块
      while (
        pendingBuffer.length >= this.blockSize ||
        (done && pendingBuffer.length > 0)
      ) {
        const isLastBlock = done && pendingBuffer.length < this.blockSize;
        const blockEnd = isLastBlock ? pendingBuffer.length : this.blockSize;
        const blockData = pendingBuffer.slice(0, blockEnd);
        pendingBuffer = pendingBuffer.slice(blockEnd);

        // 加密（不传 masterKey，Worker 已缓存）
        const encryptedBlock = await this.worker.encryptBlock(
          blockData,
          this.baseIv,
          this.globalBlockOffset,
          blockIndex,
        );

        this.encryptedBlocks.push(encryptedBlock);
        onEncrypted?.(encryptedBlock);
        blockIndex++;

        if (isLastBlock) break;
      }

      if (done) break;
    }

    return new Blob(this.encryptedBlocks);
  }

  _appendBuffer(buffer1, buffer2) {
    const newBuffer = new Uint8Array(buffer1.length + buffer2.length);
    newBuffer.set(buffer1);
    newBuffer.set(buffer2, buffer1.length);
    return newBuffer;
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
  }

  async _initMasterKey() {
    if (!this.masterKeyInitialized) {
      const masterKeyRaw = await crypto.subtle.exportKey("raw", this.masterKey);
      await this.worker.setMasterKey(masterKeyRaw);
      this.masterKeyInitialized = true;
    }
  }

  async processStream(url, onDecrypted, onProgress) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`下载失败: ${res.status}`);
    }

    // 初始化密钥（只需一次）
    await this._initMasterKey();

    const reader = res.body.getReader();
    let pendingBuffer = new Uint8Array(0);
    let blockIndex = 0;
    let totalReceived = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        totalReceived += value.byteLength;
        onProgress?.(value.byteLength, totalReceived);
        pendingBuffer = this._appendBuffer(pendingBuffer, value);
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
        const blockData = pendingBuffer.slice(0, blockEnd);
        pendingBuffer = pendingBuffer.slice(blockEnd);

        // 解密（不传 masterKey，Worker 已缓存）
        const decrypted = await this.worker.decryptBlock(
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
  }

  _appendBuffer(buffer1, buffer2) {
    const newBuffer = new Uint8Array(buffer1.length + buffer2.length);
    newBuffer.set(buffer1);
    newBuffer.set(buffer2, buffer1.length);
    return newBuffer;
  }
}
