/**
 * 加密配置
 * 可选择使用主线程加密或 Worker 加密
 */

export const ENCRYPTION_BLOCK_SIZE = 1024 * 1024;

// 默认配置
export const CryptoConfig = {
  // 是否使用 Web Worker 进行加密/解密
  // true: 在独立线程处理，不阻塞 UI（推荐）
  // false: 在主线程处理，可能造成页面卡顿
  useWorker: true,

  // 加密块大小 (1MB)
  encryptionBlockSize: ENCRYPTION_BLOCK_SIZE,
};

/**
 * 获取加密器类
 */
export async function getEncryptorClass() {
  if (CryptoConfig.useWorker) {
    const { WorkerStreamEncryptor } =
      await import("./crypto-worker-streams.js");
    return WorkerStreamEncryptor;
  } else {
    const { StreamEncryptor } = await import("./crypto.js");
    return StreamEncryptor;
  }
}

/**
 * 获取解密器类
 */
export async function getDecryptorClass() {
  if (CryptoConfig.useWorker) {
    const { WorkerStreamDecryptor } =
      await import("./crypto-worker-streams.js");
    return WorkerStreamDecryptor;
  } else {
    const { StreamDecryptor } = await import("./crypto.js");
    return StreamDecryptor;
  }
}
