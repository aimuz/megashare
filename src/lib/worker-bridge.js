/**
 * Crypto Worker 通信桥接层
 * 提供 Promise-based API 与 Worker 通信
 */

class CryptoWorkerBridge {
  constructor() {
    this.worker = null;
    this.messageId = 0;
    this.pendingMessages = new Map();
    this.ready = false;
    this.readyPromise = null;
  }

  /**
   * 初始化 Worker
   */
  async init() {
    if (this.ready) return;

    this.readyPromise = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(
          new URL("../workers/crypto-worker.js", import.meta.url),
          { type: "module" },
        );

        this.worker.addEventListener("message", (event) => {
          const { id, type, result, error } = event.data;

          // Worker 就绪通知
          if (type === "ready") {
            this.ready = true;
            resolve();
            return;
          }

          // 处理响应消息
          const pending = this.pendingMessages.get(id);
          if (!pending) return;

          this.pendingMessages.delete(id);

          if (type === "success") {
            pending.resolve(result);
          } else if (type === "error") {
            pending.reject(new Error(error));
          }
        });

        this.worker.addEventListener("error", (error) => {
          console.error("Crypto Worker error:", error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });

    return this.readyPromise;
  }

  /**
   * 发送消息到 Worker，可选支持零拷贝
   */
  async _sendMessage(type, data, transferables = []) {
    if (!this.ready) {
      await this.init();
    }

    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      this.pendingMessages.set(id, { resolve, reject });

      // 零拷贝：使用 Transferable Objects
      this.worker.postMessage({ id, type, data }, transferables);
    });
  }

  /**
   * 设置主密钥（支持多个并发会话）
   * @param {string} keyId - 密钥唯一标识
   * @param {ArrayBuffer} masterKeyRaw - 原始密钥数据
   */
  async setMasterKey(keyId, masterKeyRaw) {
    return this._sendMessage("set-master-key", { keyId, masterKeyRaw });
  }

  /**
   * 释放密钥缓存
   * @param {string} keyId - 密钥唯一标识
   */
  async releaseKey(keyId) {
    return this._sendMessage("release-key", { keyId });
  }

  /**
   * 生成主密钥
   */
  async generateMasterKey() {
    return this._sendMessage("generate-key");
  }

  /**
   * 计算哈希
   */
  async computeHash(data) {
    return this._sendMessage("compute-hash", data);
  }

  /**
   * 加密单个块
   * @param {string} keyId - 密钥唯一标识
   */
  async encryptBlock(keyId, blockData, baseIv, globalBlockOffset, blockIndex) {
    let dataToTransfer = blockData;
    let transferables = [];

    // Ensure we have a clean buffer to transfer
    if (blockData.buffer.byteLength !== blockData.byteLength) {
      // It's a view of a larger buffer, we MUST copy to transfer only this part
      // and not detach the main buffer.
      dataToTransfer = blockData.slice();
    }

    // Now dataToTransfer is own buffer or full buffer.
    transferables.push(dataToTransfer.buffer);

    const result = await this._sendMessage(
      "encrypt-block",
      {
        keyId,
        blockData: dataToTransfer,
        baseIv,
        globalBlockOffset,
        blockIndex,
      },
      transferables
    );
    return result.data;
  }

  /**
   * 解密单个块
   * @param {string} keyId - 密钥唯一标识
   */
  async decryptBlock(keyId, blockData, baseIv, globalBlockOffset, blockIndex) {
    let dataToTransfer = blockData;
    const transferables = [];

    if (blockData.buffer.byteLength !== blockData.byteLength) {
      dataToTransfer = blockData.slice();
    }
    transferables.push(dataToTransfer.buffer);

    const result = await this._sendMessage(
      "decrypt-block",
      {
        keyId,
        blockData: dataToTransfer,
        baseIv,
        globalBlockOffset,
        blockIndex,
      },
      transferables
    );
    return result.data;
  }

  /**
   * 加密元数据
   */
  async encryptMetadata(masterKeyRaw, baseIv, sensitiveMeta) {
    return this._sendMessage("encrypt-metadata", {
      masterKeyRaw,
      baseIv,
      sensitiveMeta,
    });
  }

  /**
   * 销毁 Worker
   */
  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      // Reject all pending promises
      for (const [id, pending] of this.pendingMessages) {
        pending.reject(new Error("Worker destroyed"));
      }
      this.pendingMessages.clear();
    }
  }
}

// 单例模式
let workerInstance = null;

export function getCryptoWorker() {
  if (!workerInstance) {
    workerInstance = new CryptoWorkerBridge();
  }
  return workerInstance;
}

export function destroyCryptoWorker() {
  if (workerInstance) {
    workerInstance.destroy();
    workerInstance = null;
  }
}
