# MegaShare - 端到端加密文件分享

[![Powered by Alibaba Cloud ESA](https://img.alicdn.com/imgextra/i3/O1CN01H1UU3i1Cti9lYtFrs_!!6000000000139-2-tps-7534-844.png)](https://www.alibabacloud.com/product/esa)

> **声明**：本项目由阿里云 ESA 提供加速、计算和保护

**🌐 阿里云 ESA 官网**：[边缘安全加速 ESA](https://tianchi.aliyun.com/specials/promotion/freetier/esa?taskCode=25254&recordId=05322c652b1951759121514ba18a42a3)

**🔗 在线体验**：[https://megashare-s3.c761953f.er.aliyun-esa.net](https://megashare-s3.c761953f.er.aliyun-esa.net)

## 项目简介

MegaShare 是一个基于阿里云 ESA Edge Functions 构建的端到端加密文件分享工具，让用户能够安全、快速地分享大文件。

### 🎯 实用性

- **端到端加密**：文件在浏览器端加密后上传，服务端和存储层无法获取明文内容，保障数据隐私
- **大文件支持**：支持最大 20GB 文件上传，采用分片上传技术确保可靠性
- **一键分享**：生成包含解密密钥的分享链接，接收者无需注册即可下载
- **断点续传**：支持上传/下载进度追踪和失败重试机制

### 💡 创意性

- **密钥即链接**：将 AES-256 加密密钥嵌入 URL Fragment（`#key`），既方便分享又确保密钥不会发送到服务器
- **零信任架构**：服务端仅存储加密后的数据，即使数据泄露也无法解密
- **边缘计算驱动**：利用阿里云 ESA 边缘节点就近处理请求，降低延迟
- **流量节省设计**：Edge Function 代理下载走内网流量，大幅降低成本

### 🔧 技术深度

| 技术栈       | 说明                                                          |
| ------------ | ------------------------------------------------------------- |
| **前端**     | Svelte 5 + Vite + TailwindCSS，纯浏览器端 Web Crypto API 加密 |
| **边缘计算** | 阿里云 ESA Edge Functions，处理上传/下载路由和鉴权            |
| **存储**     | 阿里云 OSS（S3 兼容），存储加密分片和元数据                   |
| **安全**     | AES-256-GCM 加密 + HMAC-SHA256 上传令牌签名                   |

**核心技术亮点**：

1. **分片加密上传**：大文件切分为 10MB 分片，每片独立加密后通过预签名 URL 直传 OSS
2. **流式解密下载**：边缘节点代理获取分片，前端流式解密写入本地文件
3. **AWS SDK v3 集成**：在 Edge Functions 中使用官方 AWS SDK 操作 S3 兼容存储
4. **无状态令牌验证**：HMAC 签名令牌包含文件ID和分片数，无需数据库即可验证上传权限

## 快速开始

```bash
# 安装依赖
npm install

# 本地开发
npm run dev

# 构建
npm run build

# 部署到阿里云 ESA
npx esa deploy
```

## 配置

在阿里云 ESA EdgeKV `megashare-config` 中配置：

```
S3_ENDPOINT          = oss-cn-shanghai.aliyuncs.com
S3_BUCKET            = your-bucket-name
S3_ACCESS_KEY_ID     = your-access-key
S3_ACCESS_KEY_SECRET = your-secret-key
S3_REGION            = cn-shanghai
UPLOAD_SECRET        = your-upload-secret
```

## 架构图

```
┌─────────────┐     ┌─────────────────────┐     ┌─────────────┐
│   Browser   │────▶│  ESA Edge Function  │────▶│  OSS (S3)   │
│ (加密/解密)  │◀────│  (路由/鉴权/代理)    │◀────│ (加密存储)   │
└─────────────┘     └─────────────────────┘     └─────────────┘
```

## License

MIT
