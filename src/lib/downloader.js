/**
 * 文件下载模块
 */

import { importMasterKey, decodeBase64 } from "./crypto.js";
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
   * 流式下载并解密
   */
  async _downloadChunk(chunkIndex, writable, masterKey, baseIv, chunkBaseBytes, onProgress) {
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
        (bytes, total) => onProgress(bytes, chunkBaseBytes + total),
      );
    });

    return cumulativeBytes;
  }

  /**
   * 执行下载
   */
  async download(masterKeyStr, writable, onProgress) {
    const masterKey = await importMasterKey(decodeBase64(masterKeyStr));
    const baseIv = new Uint8Array(this.metaData.iv);

    let cumulativeBytes = 0;

    for (let i = 0; i < this.metaData.totalChunks; i++) {
      const chunkBaseBytes = cumulativeBytes;
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
    }
  }
}
