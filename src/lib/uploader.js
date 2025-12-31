/**
 * 文件上传模块
 */

import { generateMasterKey, exportMasterKey, hashData, encryptSensitiveMeta } from "./crypto.js";
import { withRetry } from "./utils.js";
import { getEncryptorClass, ENCRYPTION_BLOCK_SIZE } from "./crypto-config.js";

/**
 * 上传器类
 */
export class FileUploader {
  constructor(file, serverConfig) {
    this.file = file;
    this.serverConfig = serverConfig;
    this.uploadedBytes = 0;
    this.totalBytes = file.size;
    this.totalChunks = Math.ceil(file.size / serverConfig.chunkSize);
  }

  /**
   * 初始化上传会话
   */
  async _initUpload() {
    const res = await fetch("/api/upload/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileSize: this.file.size }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Init failed");
    }
    return res.json();
  }

  /**
   * 获取上传规格
   */
  async _getUploadSpec(fileId, chunkIndex, chunkSize, contentHash, uploadToken) {
    const res = await fetch("/api/upload/chunk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Token": uploadToken,
      },
      body: JSON.stringify({
        fileId,
        chunkIndex,
        chunkSize,
        contentHash,
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Get upload spec failed: ${errData.error || res.statusText}`);
    }
    return res.json();
  }

  /**
   * 使用 XHR 上传数据
   */
  _uploadWithXHR(uploadSpec, data, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        reject(new Error(`Upload failed: ${xhr.status}`));
      };

      xhr.onerror = () => reject(new Error("Network error"));

      xhr.open(uploadSpec.method, uploadSpec.url);
      if (uploadSpec.headers) {
        for (const [key, value] of Object.entries(uploadSpec.headers)) {
          xhr.setRequestHeader(key, value);
        }
      }

      if (uploadSpec.bodyType === "form-data") {
        const form = new FormData();
        // data 已经是 Blob，直接使用
        form.append(uploadSpec.fieldName || "file", data);
        xhr.send(form);
      } else {
        xhr.send(data);
      }
    });
  }

  /**
   * 通知服务端分片上传完成
   */
  async _notifyChunkComplete(fileId, chunkIndex, chunkFileId, uploadId, contentHash, uploadToken) {
    const res = await fetch("/api/upload/chunk", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Token": uploadToken,
      },
      body: JSON.stringify({
        fileId,
        chunkIndex,
        chunkFileId,
        uploadId,
        contentHash,
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        `Chunk ${chunkIndex} completion notification failed: ${errData.error || res.statusText}`,
      );
    }
  }

  /**
   * 上传单个分块
   */
  async _uploadChunk(fileSlice, chunkIndex, masterKey, baseIv, fileId, uploadToken, onProgress) {
    // 动态获取加密器类（支持 Worker 或主线程）
    const EncryptorClass = await getEncryptorClass();

    // 流式加密
    const encryptor = new EncryptorClass(
      masterKey,
      baseIv,
      chunkIndex,
      this.serverConfig.chunkSize,
      ENCRYPTION_BLOCK_SIZE,
    );

    const {
      blob: encryptedBlob,
      size: encryptedSize,
      hash: contentHash,
    } = await encryptor.processStream(fileSlice);

    // 上传
    const chunkFileId = await withRetry(async () => {
      const bytesBeforeAttempt = this.uploadedBytes;
      let chunkUploaded = 0;

      try {
        const { uploadSpec, chunkFileId, uploadId } = await this._getUploadSpec(
          fileId,
          chunkIndex,
          encryptedSize,
          contentHash,
          uploadToken,
        );

        await this._uploadWithXHR(uploadSpec, encryptedBlob, (loaded) => {
          const delta = loaded - chunkUploaded;
          chunkUploaded = loaded;
          this.uploadedBytes += delta;
          onProgress(delta, this.uploadedBytes);
        });

        await this._notifyChunkComplete(
          fileId,
          chunkIndex,
          chunkFileId,
          uploadId,
          contentHash,
          uploadToken,
        );
        return chunkFileId;
      } catch (err) {
        this.uploadedBytes = bytesBeforeAttempt;
        onProgress(0, 0);
        throw err;
      }
    });

    return chunkFileId;
  }

  /**
   * 完成整个上传
   */
  async _finalizeUpload(fileId, fileMeta, chunkIds, uploadToken) {
    const res = await fetch("/api/upload/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Token": uploadToken,
      },
      body: JSON.stringify({
        fileId,
        metadata: fileMeta,
        chunkIds,
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Upload finalization failed: ${errData.error || res.statusText}`);
    }
  }

  /**
   * 执行上传
   */
  async upload(onProgress, onStatusUpdate) {
    // 1. 初始化
    const { fileId, uploadToken } = await this._initUpload();

    // 2. 准备加密
    const masterKey = await generateMasterKey();
    const masterKeyStr = await exportMasterKey(masterKey);
    const baseIv = window.crypto.getRandomValues(new Uint8Array(12));
    const keyHash = await hashData(masterKeyStr);

    const uploadedChunkIds = [];

    onStatusUpdate({
      action: "准备上传",
      size: `${this.totalChunks} 个分块`,
      speed: "",
      eta: "",
    });

    // 3. 逐块上传
    for (let i = 0; i < this.totalChunks; i++) {
      const start = i * this.serverConfig.chunkSize;
      const end = Math.min(start + this.serverConfig.chunkSize, this.file.size);
      const fileSlice = this.file.slice(start, end);

      const chunkFileId = await this._uploadChunk(
        fileSlice,
        i,
        masterKey,
        baseIv,
        fileId,
        uploadToken,
        onProgress,
      );

      uploadedChunkIds.push({ index: i, fileId: chunkFileId });
    }

    // 4. 完成上传
    onStatusUpdate({ action: "正在完成上传..." });

    const sensitiveMeta = {
      name: this.file.name,
      type: this.file.type || "application/octet-stream",
    };
    const encryptedMeta = await encryptSensitiveMeta(masterKey, baseIv, sensitiveMeta);

    const fileMeta = {
      size: this.file.size,
      iv: Array.from(baseIv),
      keyHash,
      createdAt: Date.now(),
      totalChunks: this.totalChunks,
      encryptedMeta,
      encryptionBlockSize: ENCRYPTION_BLOCK_SIZE,
      chunkSize: this.serverConfig.chunkSize,
    };

    await this._finalizeUpload(fileId, fileMeta, uploadedChunkIds, uploadToken);

    return { fileId, masterKeyStr };
  }
}
