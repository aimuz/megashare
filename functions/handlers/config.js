/**
 * Config handler for ESA Edge Function
 * 提供客户端配置信息
 */

import { getChunkSize, getMaxFileSize } from "../utils.js";
import { createStorageBackend } from "../storage/storage.js";

/**
 * 获取客户端配置
 * GET /api/config
 *
 * Response:
 *   { supportsDirectUrl, supportsDirectUpload, chunkSize, maxFileSize }
 */
export async function handleGetConfig(c) {
  const storage = await createStorageBackend();

  return c.json({
    supportsDirectUrl: storage.supportsDirectUrl,
    supportsDirectUpload: storage.supportsDirectUpload,
    chunkSize: getChunkSize(),
    maxFileSize: getMaxFileSize(),
  });
}
