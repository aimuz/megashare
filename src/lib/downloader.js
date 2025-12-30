/**
 * 文件下载模块
 */

import { importMasterKey, decryptChunk } from "./crypto.js";
import { withRetry } from "./utils.js";
import { getDecryptorClass } from "./crypto-config.js";

/**
 * 下载器类
 */
export class FileDownloader {
  constructor(fileId, metaData) {
    this.fileId = fileId;
    this.metaData = metaData;
    this.downloadedBytes = 0;
    this.totalBytes = metaData.size;
  }

  /**
   * 获取分块 URL
   */
  _getChunkURL(chunkIndex) {
    return `/api/file/${this.fileId}/chunk/${chunkIndex}`;
  }

  /**
   * 旧方式：下载并返回完整数据
   */
  async _fetchChunkData(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`下载失败: ${res.status}`);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.byteLength;
      onProgress(value.byteLength, received);
    }

    // 合并所有块
    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return buffer;
  }

  /**
   * 流式下载并解密
   */
  async _downloadChunk(
    chunkIndex,
    writable,
    masterKey,
    baseIv,
    chunkBaseBytes,
    onProgress,
  ) {
    let cumulativeBytes = chunkBaseBytes;

    // 动态获取解密器类（支持 Worker 或主线程）
    const DecryptorClass = await getDecryptorClass();
    const chunkSize = this.metaData.chunkSize || this.metaData.blockSize;
    await withRetry(async () => {
      cumulativeBytes = chunkBaseBytes;
      await writable.seek(chunkBaseBytes);
      const decryptor = new DecryptorClass(
        masterKey,
        baseIv,
        chunkIndex,
        chunkSize,
        this.metaData.encryptionBlockSize,
      );

      await decryptor.processStream(
        this._getChunkURL(chunkIndex),
        async (decrypted) => {
          await writable.write(decrypted);
          cumulativeBytes += decrypted.byteLength;
        },
        (bytes, total) => onProgress(bytes, cumulativeBytes),
      );
    });

    return cumulativeBytes;
  }

  /**
   * 旧方式：下载并解密（向后兼容）
   */
  async _downloadChunkLegacy(
    chunkIndex,
    writable,
    masterKey,
    baseIv,
    chunkBaseBytes,
    onProgress,
  ) {
    const decryptedBuffer = await withRetry(async () => {
      const url = this._getChunkURL(chunkIndex);
      const encryptedData = await this._fetchChunkData(url, (bytes, total) =>
        onProgress(bytes, chunkBaseBytes + total),
      );

      return await decryptChunk(encryptedData, masterKey, baseIv, chunkIndex);
    });

    await writable.write(decryptedBuffer);
    return chunkBaseBytes + decryptedBuffer.byteLength;
  }

  /**
   * 执行下载
   */
  async download(masterKeyStr, writable, onProgress) {
    const masterKey = await importMasterKey(masterKeyStr);
    const baseIv = new Uint8Array(this.metaData.iv);

    let cumulativeBytes = 0;
    const useNewMethod = !!this.metaData.encryptionBlockSize;

    for (let i = 0; i < this.metaData.totalChunks; i++) {
      const chunkBaseBytes = cumulativeBytes;
      if (useNewMethod) {
        cumulativeBytes = await this._downloadChunk(
          i,
          writable,
          masterKey,
          baseIv,
          chunkBaseBytes,
          (bytes, total) => {
            this.downloadedBytes = total;
            onProgress(bytes, total);
          },
        );
      } else {
        cumulativeBytes = await this._downloadChunkLegacy(
          i,
          writable,
          masterKey,
          baseIv,
          chunkBaseBytes,
          (bytes, total) => {
            this.downloadedBytes = total;
            onProgress(bytes, total);
          },
        );
      }
    }
  }
}
