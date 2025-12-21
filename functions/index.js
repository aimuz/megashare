/**
 * MegaShare ESA Edge Function
 * 统一入口点 + 路由
 */

import { errorResponse, handleCORS } from "./utils.js";
import {
    handleUploadStart,
    handleUploadChunk,
    handleUploadChunkComplete,
    handleUploadComplete,
} from "./handlers/upload.js";
import { handleGetFile, handleDownloadChunk } from "./handlers/file.js";

export default {
    async fetch(request, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS 预检
        if (method === "OPTIONS") {
            return handleCORS();
        }

        try {
            // --- Upload 路由 ---

            if (path === "/api/upload/start" && method === "POST") {
                return await handleUploadStart(request);
            }

            if (path === "/api/upload/chunk" && method === "POST") {
                return await handleUploadChunk(request);
            }

            if (path === "/api/upload/chunk" && method === "PUT") {
                return await handleUploadChunkComplete(request);
            }

            if (path === "/api/upload/complete" && method === "POST") {
                return await handleUploadComplete(request);
            }

            // --- File 路由 ---

            // 动态路由: /api/file/:id/chunk/:chunkIndex/download
            const chunkMatch = path.match(/^\/api\/file\/([^/]+)\/chunk\/(\d+)\/download$/);
            if (chunkMatch && method === "GET") {
                return await handleDownloadChunk(
                    chunkMatch[1],
                    parseInt(chunkMatch[2], 10)
                );
            }

            // 动态路由: /api/file/:id
            const fileMatch = path.match(/^\/api\/file\/([^/]+)$/);
            if (fileMatch && method === "GET") {
                return await handleGetFile(fileMatch[1]);
            }

            // 404
            return new Response("Not Found", { status: 404 });
        } catch (err) {
            return errorResponse(err.message);
        }
    },
};
