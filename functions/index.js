/**
 * MegaShare ESA Edge Function
 * 统一入口点 + 路由
 */

import {
    handleUploadStart,
    handleUploadChunk,
    handleUploadChunkData,
    handleUploadChunkComplete,
    handleUploadComplete,
} from "./handlers/upload.js";
import { handleGetFile, handleGetChunk } from "./handlers/file.js";
import { handleGC } from "./handlers/gc.js";
import { handleGetConfig } from "./handlers/config.js";

// 导入 KV 适配器以触发插件注册
import "./kv/edgekv.js";

// 导入 ENV 适配器以触发插件注册
import "./env/edgeenv.js";
import { loadEnv } from "./env/edgeenv.js";

// 导入存储后端以触发插件注册
import "./storage/s3.js";

import { Hono } from 'hono'
const app = new Hono()

// 统一错误处理
app.onError((err, c) => {
    console.error(`[Error] ${c.req.method} ${c.req.path}:`, err.message || err);

    // 避免暴露内部错误细节
    const status = err.status || 500;
    const message = status < 500 ? err.message : "Internal Server Error";

    return c.json({ error: message }, status);
});

// 在所有请求前加载环境变量
app.use("*", async (c, next) => {
    await loadEnv();
    await next();
});

app.post("/api/upload/start", handleUploadStart)
app.post("/api/upload/chunk", handleUploadChunk)
app.put("/api/upload/chunk", handleUploadChunkComplete)
app.post("/api/upload/chunk/data", handleUploadChunkData)
app.post("/api/upload/complete", handleUploadComplete)
app.get("/api/file/:id/chunk/:chunkIndex", handleGetChunk)
app.get("/api/file/:id", handleGetFile)
app.post("/api/gc", handleGC)
app.get("/api/config", handleGetConfig)

export default app
