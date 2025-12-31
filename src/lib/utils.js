/**
 * 通用工具函数
 */

// Retry helper with exponential backoff
const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 1000;

export const withRetry = async (
  fn,
  retries = MAX_RETRIES,
  delayMs = RETRY_DELAY_MS,
) => {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = delayMs * Math.pow(2, attempt);
        console.warn(
          `Attempt ${attempt + 1} failed, retrying in ${delay}ms...`,
          err.message,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
};

// Format helpers
const formatUnit = (value, units) => {
  if (!value || value <= 0) return `0 ${units[0]}`;
  const i = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
};

export const formatSpeed = (bps) =>
  formatUnit(bps, ["B/s", "KB/s", "MB/s", "GB/s"]);

export const formatBytes = (bytes) =>
  formatUnit(bytes, ["B", "KB", "MB", "GB", "TB"]);

export const formatETA = (seconds) => {
  if (!seconds || seconds === Infinity || seconds < 0) return "";
  const totalSeconds = Math.ceil(seconds);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
  }
  return `${Math.floor(totalSeconds / 3600)} 时 ${Math.floor((totalSeconds % 3600) / 60)} 分`;
};

export const formatTimeRemaining = (ms) => {
  if (!ms || ms <= 0) return null;
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return "即将过期";
};

/**
 * Real-time speed tracker using sliding window with EMA smoothing
 */
export class SpeedTracker {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.samples = [];
    this.smoothedSpeed = 0;
    this.smoothingFactor = 0.3;
  }

  record(bytes) {
    const now = Date.now();
    this.samples.push({ timestamp: now, bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].timestamp < cutoff) {
      this.samples.shift();
    }
  }

  speed() {
    if (this.samples.length < 2) return this.smoothedSpeed;

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const windowSamples = this.samples.filter((s) => s.timestamp >= cutoff);
    if (windowSamples.length < 2) return this.smoothedSpeed;

    const elapsed = (now - windowSamples[0].timestamp) / 1000;
    if (elapsed < 0.5) return this.smoothedSpeed;

    const totalBytes = windowSamples.reduce((sum, s) => sum + s.bytes, 0);
    let rawSpeed = totalBytes / elapsed;

    const MAX_SPEED = 1024 * 1024 * 1024;
    rawSpeed = Math.min(rawSpeed, MAX_SPEED);

    if (this.smoothedSpeed === 0) {
      this.smoothedSpeed = rawSpeed;
    } else {
      this.smoothedSpeed =
        this.smoothingFactor * rawSpeed +
        (1 - this.smoothingFactor) * this.smoothedSpeed;
    }

    return this.smoothedSpeed;
  }
}

export function appendBuffer(buffer1, buffer2) {
  const newBuffer = new Uint8Array(buffer1.length + buffer2.length);
  newBuffer.set(buffer1);
  newBuffer.set(buffer2, buffer1.length);
  return newBuffer;
}

/**
 * 高效的缓冲区累加器
 * 使用延迟合并策略减少内存分配次数
 */
export class BufferAccumulator {
  constructor() {
    this.chunks = [];
    this.totalLength = 0;
  }

  /**
   * 追加数据块
   * @param {Uint8Array} chunk
   */
  append(chunk) {
    this.chunks.push(chunk);
    this.totalLength += chunk.byteLength;
  }

  /**
   * 获取当前累积的总长度
   */
  get length() {
    return this.totalLength;
  }

  /**
   * 消费指定长度的数据
   * @param {number} size - 需要消费的字节数
   * @returns {Uint8Array} - 消费的数据
   */
  consume(size) {
    if (size > this.totalLength) {
      throw new Error(
        `Cannot consume ${size} bytes, only ${this.totalLength} available`,
      );
    }

    // 快速路径：第一个块足够大
    if (this.chunks.length > 0 && this.chunks[0].byteLength >= size) {
      const first = this.chunks[0];
      const result = first.subarray(0, size);

      if (first.byteLength === size) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(size);
      }

      this.totalLength -= size;
      return result;
    }

    // 需要合并多个块
    const result = new Uint8Array(size);
    let offset = 0;
    let remaining = size;

    while (remaining > 0 && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.byteLength, remaining);

      result.set(chunk.subarray(0, take), offset);
      offset += take;
      remaining -= take;

      if (take === chunk.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(take);
      }
    }

    this.totalLength -= size;
    return result;
  }

  /**
   * 消费所有剩余数据
   * @returns {Uint8Array}
   */
  consumeAll() {
    if (this.totalLength === 0) {
      return new Uint8Array(0);
    }

    // 快速路径：只有一个块
    if (this.chunks.length === 1) {
      const result = this.chunks[0];
      this.chunks = [];
      this.totalLength = 0;
      return result;
    }

    // 合并所有块
    const result = new Uint8Array(this.totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    this.chunks = [];
    this.totalLength = 0;
    return result;
  }

  /**
   * 清空累加器
   */
  clear() {
    this.chunks = [];
    this.totalLength = 0;
  }
}

/**
 * 将 Uint8Array 转换为十六进制字符串
 */
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
