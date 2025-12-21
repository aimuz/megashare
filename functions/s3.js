/**
 * S3 兼容存储客户端
 * 使用 AWS SDK v3
 */

import {
    S3Client as AwsS3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getConfig } from "./utils.js";

// --- 配置获取 ---

async function getS3Config() {
    const [endpoint, bucket, accessKeyId, accessKeySecret, region] =
        await Promise.all([
            getConfig("S3_ENDPOINT"),
            getConfig("S3_BUCKET"),
            getConfig("S3_ACCESS_KEY_ID"),
            getConfig("S3_ACCESS_KEY_SECRET"),
            getConfig("S3_REGION"),
        ]);

    if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
        throw new Error("Missing S3 configuration in EdgeKV");
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
        region: region || "cn-shanghai",
    };
}

// --- S3 客户端 ---

class S3Client {
    constructor(config) {
        this.bucket = config.bucket;
        this.client = new AwsS3Client({
            endpoint: config.endpoint,
            region: config.region,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.accessKeySecret,
            },
            forcePathStyle: true, // 阿里云 OSS 需要
        });
    }

    /**
     * 上传对象
     */
    async putObject(key, body, contentType = "application/octet-stream") {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
        });

        await this.client.send(command);
        return { key };
    }

    /**
     * 获取对象
     */
    async getObject(key) {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });

        const response = await this.client.send(command);
        return response.Body;
    }

    /**
     * 删除对象
     */
    async deleteObject(key) {
        const command = new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });

        await this.client.send(command);
        return { deleted: true };
    }

    /**
     * 生成预签名 URL（用于前端直接上传/下载）
     */
    async getSignedUrl(key, method = "GET", expiresIn = 3600) {
        const Command = method === "PUT" ? PutObjectCommand : GetObjectCommand;
        const command = new Command({
            Bucket: this.bucket,
            Key: key,
        });

        return await getSignedUrl(this.client, command, { expiresIn });
    }
}

/**
 * 从 KV 配置创建客户端
 */
async function createS3Client() {
    const config = await getS3Config();
    return new S3Client(config);
}

export { S3Client, createS3Client };
