/**
 * S3 兼容存储后端实现
 * 支持 AWS S3、阿里云 OSS、MinIO 等 S3 兼容存储
 */

import {
    S3Client as AwsS3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getConfig } from "../utils.js";

// --- 配置获取 ---

function getS3Config() {
    const endpoint = getConfig("S3_ENDPOINT");
    const bucket = getConfig("S3_BUCKET");
    const accessKeyId = getConfig("S3_ACCESS_KEY_ID");
    const accessKeySecret = getConfig("S3_ACCESS_KEY_SECRET");
    const region = getConfig("S3_REGION");
    const prefix = getConfig("S3_PREFIX");

    if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
        throw new Error("Missing required S3 configuration (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_ACCESS_KEY_SECRET)");
    }

    // 确保 endpoint 包含协议
    let normalizedEndpoint = endpoint.replace(/\/$/, "");
    if (!normalizedEndpoint.startsWith("http://") && !normalizedEndpoint.startsWith("https://")) {
        normalizedEndpoint = "https://" + normalizedEndpoint;
    }

    return {
        endpoint: normalizedEndpoint,
        bucket,
        accessKeyId,
        accessKeySecret,
        region: region || "us-east-1",
        prefix: prefix || "megashare/",
    };
}

// --- S3 客户端 ---

class S3Client {
    constructor(config) {
        this.bucket = config.bucket;
        this.prefix = config.prefix;
        this.endpoint = config.endpoint;
        this.client = new AwsS3Client({
            endpoint: config.endpoint,
            region: config.region,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.accessKeySecret,
            },
            forcePathStyle: true,
        });
    }

    _key(path) {
        return this.prefix + path;
    }

    async putObject(key, body, contentType = "application/octet-stream") {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key),
            Body: body,
            ContentType: contentType,
        });
        await this.client.send(command);
        return { key };
    }

    async getObject(key) {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key),
        });
        return this.client.send(command);
    }

    async deleteObject(key) {
        const command = new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key),
        });
        await this.client.send(command);
    }

    async getSignedUploadUrl(key, expiresIn = 3600) {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key),
            ContentType: "application/octet-stream",
        });
        return getSignedUrl(this.client, command, { expiresIn });
    }

    async getSignedDownloadUrl(key, expiresIn = 3600) {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key),
        });
        return getSignedUrl(this.client, command, { expiresIn });
    }
}

// --- StorageBackend 接口适配 ---

/**
 * S3 存储后端
 * @implements {import('./storage.js').StorageBackend}
 */
class S3Backend {
    constructor(client) {
        this.client = client;
        this.supportsDirectUrl = true;  // S3 支持预签名 URL
        this.supportsDirectUpload = true;  // S3 支持预签名上传
        this.supportsFolderDelete = false;  // S3 不支持文件夹概念，需逐个删除
    }

    /**
     * 创建"文件夹"（S3 没有真正的文件夹，只是前缀）
     * 返回的 folderId 就是前缀路径
     */
    async createFolder(name) {
        // S3 不需要真正创建文件夹，直接返回路径作为 ID
        return { folderId: name + "/" };
    }

    /**
     * 创建文件并返回预签名上传 URL
     */
    async createFileAndGetUploadUrl(parentId, name, size, hash = "") {
        const key = parentId + name;
        const uploadUrl = await this.client.getSignedUploadUrl(key);

        return {
            fileId: key,
            uploadId: key, // S3 单次上传不需要 uploadId
            exist: false,
            uploadSpec: {
                url: uploadUrl,
                method: "PUT",
                headers: {
                    "Content-Type": "application/octet-stream",
                },
            },
        };
    }

    /**
     * 完成上传（S3 单次上传无需额外操作）
     */
    async completeUpload(fileId, uploadId, hash = "") {
        // S3 PUT 上传完成后无需额外调用
        return;
    }

    /**
     * 代理上传文件
     */
    async uploadFile(parentId, name, data, hash = "") {
        const key = parentId + name;
        await this.client.putObject(key, data);
        return { fileId: key };
    }

    /**
     * 获取下载 URL（预签名）
     */
    async getDownloadUrl(fileId) {
        return this.client.getSignedDownloadUrl(fileId);
    }

    /**
     * 流式获取文件内容
     */
    async streamFile(fileId) {
        const response = await this.client.getObject(fileId);
        // AWS SDK 返回的 Body 是 ReadableStream
        return new Response(response.Body, {
            headers: {
                "Content-Type": response.ContentType || "application/octet-stream",
                "Content-Length": response.ContentLength?.toString() || "",
            },
        });
    }

    /**
     * 删除文件
     */
    async deleteFile(fileIds) {
        const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
        for (const id of ids) {
            await this.client.deleteObject(id);
        }
    }
}

/**
 * 创建 S3 后端实例
 * @returns {Promise<S3Backend>}
 */
export async function createS3Backend() {
    const config = getS3Config();
    const client = new S3Client(config);
    return new S3Backend(client);
}

// --- 插件自注册 ---
import { registerBackend } from "./storage.js";
registerBackend("s3", createS3Backend);

export { S3Client, S3Backend };

