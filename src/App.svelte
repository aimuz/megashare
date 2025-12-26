<script>
    import {
        Shield,
        Upload,
        Download,
        Check,
        File as FileIcon,
        Lock,
        LockOpen,
        CircleAlert,
        Share2,
        HardDrive,
        ChevronRight,
        Clock,
    } from "lucide-svelte";
    import { showSaveFilePicker } from "native-file-system-adapter";

    // --- Server Configuration (single source of truth) ---
    let serverConfig = $state({
        supportsDirectUrl: true,
        supportsDirectUpload: true,
        chunkSize: 128 * 1024 * 1024, // 128MB (default)
        maxFileSize: 20 * 1024 * 1024 * 1024, // 20GB (default)
    });

    // Retry helper with exponential backoff
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;

    const withRetry = async (
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
                    const delay = delayMs * Math.pow(2, attempt); // Exponential backoff
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

    const formatUnit = (value, units) => {
        if (!value || value <= 0) return `0 ${units[0]}`;
        const i = Math.min(
            Math.floor(Math.log(value) / Math.log(1024)),
            units.length - 1,
        );
        return `${(value / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
    };

    const formatSpeed = (bps) =>
        formatUnit(bps, ["B/s", "KB/s", "MB/s", "GB/s"]);
    const formatBytes = (bytes) =>
        formatUnit(bytes, ["B", "KB", "MB", "GB", "TB"]);

    // Helper to format ETA
    const formatETA = (seconds) => {
        if (!seconds || seconds === Infinity || seconds < 0) return "";
        if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
        if (seconds < 3600)
            return `${Math.floor(seconds / 60)} 分 ${Math.ceil(seconds % 60)} 秒`;
        return `${Math.floor(seconds / 3600)} 时 ${Math.floor((seconds % 3600) / 60)} 分`;
    };

    // Helper to format remaining time for file expiry (hours/minutes)
    const formatTimeRemaining = (ms) => {
        if (!ms || ms <= 0) return null;
        const hours = Math.floor(ms / (1000 * 60 * 60));
        const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
        if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
        if (minutes > 0) return `${minutes} 分钟`;
        return "即将过期";
    };

    // Real-time speed tracker using sliding window with EMA smoothing
    class SpeedTracker {
        constructor(windowMs = 2000) {
            this.windowMs = windowMs;
            this.samples = []; // {timestamp, bytes}
            this.smoothedSpeed = 0;
            this.smoothingFactor = 0.3; // EMA alpha: lower = smoother, higher = more responsive
        }

        record(bytes) {
            const now = Date.now();
            this.samples.push({ timestamp: now, bytes });
            // Remove samples outside the window
            const cutoff = now - this.windowMs;
            while (
                this.samples.length > 0 &&
                this.samples[0].timestamp < cutoff
            ) {
                this.samples.shift();
            }
        }

        speed() {
            if (this.samples.length < 2) return this.smoothedSpeed;

            const now = Date.now();
            const cutoff = now - this.windowMs;
            // Filter samples within window
            const windowSamples = this.samples.filter(
                (s) => s.timestamp >= cutoff,
            );
            if (windowSamples.length < 2) return this.smoothedSpeed;

            // Require minimum elapsed time to avoid division by tiny values
            const elapsed = (now - windowSamples[0].timestamp) / 1000;
            if (elapsed < 0.5) return this.smoothedSpeed; // Need at least 500ms of data

            const totalBytes = windowSamples.reduce(
                (sum, s) => sum + s.bytes,
                0,
            );

            let rawSpeed = totalBytes / elapsed;

            // Cap unrealistic speeds (max 1GB/s)
            const MAX_SPEED = 1024 * 1024 * 1024;
            rawSpeed = Math.min(rawSpeed, MAX_SPEED);

            // Apply exponential moving average for smoothing
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

    // Generate a Master Key for the file
    const generateMasterKey = async () => {
        const key = await window.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"],
        );
        const exported = await window.crypto.subtle.exportKey("raw", key);
        return btoa(String.fromCharCode(...new Uint8Array(exported)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");
    };

    // Import the Master Key
    const importMasterKey = async (base64Key) => {
        const rawKey = Uint8Array.from(
            atob(base64Key.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
        );
        return await window.crypto.subtle.importKey(
            "raw",
            rawKey,
            "AES-GCM",
            true,
            ["encrypt", "decrypt"],
        );
    };

    // Helper to hash strings for verification
    const hashData = async (dataStr) => {
        const enc = new TextEncoder();
        const hashBuffer = await window.crypto.subtle.digest(
            "SHA-256",
            enc.encode(dataStr),
        );
        return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");
    };

    // Helper to derive IV for a specific chunk index
    const getChunkIV = (baseIv, index) => {
        const iv = new Uint8Array(baseIv);
        const view = new DataView(iv.buffer);
        const lastUint32 = view.getUint32(8, false);
        view.setUint32(8, lastUint32 + index, false);
        return iv;
    };

    // Encrypt sensitive metadata (name, type) with master key
    const encryptSensitiveMeta = async (masterKey, baseIv, sensitiveMeta) => {
        const jsonStr = JSON.stringify(sensitiveMeta);
        const encoded = new TextEncoder().encode(jsonStr);
        // Use index -1 for metadata IV (different from chunk IVs)
        const metaIv = getChunkIV(baseIv, 0xffffffff);
        const encrypted = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: metaIv },
            masterKey,
            encoded,
        );
        // Convert to base64 for JSON storage
        return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    };

    // Decrypt sensitive metadata
    const decryptSensitiveMeta = async (
        masterKeyStr,
        baseIv,
        encryptedMeta,
    ) => {
        try {
            const masterKey = await importMasterKey(masterKeyStr);
            const ivArray = new Uint8Array(baseIv);
            const metaIv = getChunkIV(ivArray, 0xffffffff);
            const encrypted = Uint8Array.from(atob(encryptedMeta), (c) =>
                c.charCodeAt(0),
            );
            const decrypted = await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: metaIv },
                masterKey,
                encrypted,
            );
            const jsonStr = new TextDecoder().decode(decrypted);
            return JSON.parse(jsonStr);
        } catch (e) {
            console.error("Failed to decrypt metadata:", e);
            return null;
        }
    };

    // State
    let view = $state("home"); // home, processing, success, download
    let file = $state(null);
    let progress = $state(0);
    // 结构化状态，避免布局跳动
    let statusInfo = $state({ action: "", size: "", speed: "", eta: "" });
    let shareLink = $state("");
    let error = $state("");
    let copied = $state(false);

    // Download state
    let metaData = $state(null);
    let urlParams = $state({ id: "", key: "" });

    // 2. Detect URL params and cleanup old service workers
    $effect(() => {
        if (typeof window !== "undefined") {
            // Cleanup any old service workers (from previous StreamSaver.js)
            if ("serviceWorker" in navigator) {
                navigator.serviceWorker
                    .getRegistrations()
                    .then((registrations) => {
                        for (const registration of registrations) {
                            registration.unregister();
                        }
                    });
            }

            const params = new URLSearchParams(window.location.search);
            const id = params.get("f");
            const key = window.location.hash.substring(1);

            if (id && key && (urlParams.id !== id || urlParams.key !== key)) {
                urlParams = { id, key };
                view = "download";
                fetchMetadata(id, key);
            }

            // Fetch server configuration
            fetchServerConfig();
        }
    });

    // Fetch server configuration
    const fetchServerConfig = async () => {
        try {
            const res = await fetch("/api/config");
            if (res.ok) {
                serverConfig = await res.json();
            }
        } catch (err) {
            console.warn("Failed to fetch server config, using defaults", err);
        }
    };

    // Fetch Metadata from API and decrypt sensitive fields
    const fetchMetadata = async (id, key) => {
        try {
            const res = await fetch(`/api/file/${id}`);
            if (!res.ok) throw new Error("File not found");
            const data = await res.json();
            const rawMeta = data.metadata;

            // Verify key hash first
            if (key && rawMeta.keyHash) {
                const inputKeyHash = await hashData(key);
                if (inputKeyHash !== rawMeta.keyHash) {
                    error = "解密密钥不正确。";
                    return;
                }
            }

            // If encrypted metadata exists, decrypt it
            if (rawMeta.encryptedMeta && key) {
                const sensitiveMeta = await decryptSensitiveMeta(
                    key,
                    rawMeta.iv,
                    rawMeta.encryptedMeta,
                );
                if (sensitiveMeta) {
                    rawMeta.name = sensitiveMeta.name;
                    rawMeta.type = sensitiveMeta.type;
                } else {
                    rawMeta.name = "加密文件";
                    rawMeta.type = "application/octet-stream";
                }
            }

            metaData = rawMeta;
        } catch (err) {
            error = "无法获取文件元数据或文件不存在。";
        }
    };

    // 3. Encryption and Upload

    /**
     * 初始化上传会话
     */
    const initUpload = async (fileSize) => {
        const res = await fetch("/api/upload/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileSize }),
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || "Init failed");
        }
        return res.json();
    };

    /**
     * 加密分片数据
     */
    const encryptChunk = async (chunkBuffer, masterKey, baseIv, chunkIndex) => {
        const iv = getChunkIV(baseIv, chunkIndex);
        return window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            masterKey,
            chunkBuffer,
        );
    };

    /**
     * 解密 chunk 数据
     */
    const decryptChunk = async (
        encryptedData,
        masterKey,
        baseIv,
        chunkIndex,
    ) => {
        const iv = getChunkIV(baseIv, chunkIndex);
        try {
            return await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv },
                masterKey,
                encryptedData,
            );
        } catch {
            throw new Error(
                `分块 ${chunkIndex} 解密失败。数据可能已被篡改或密钥错误。`,
            );
        }
    };

    /**
     * 计算 SHA256 哈希
     */
    const computeHash = async (data) => {
        const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(hashBuffer))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    };

    /**
     * 获取上传规格
     */
    const getUploadSpec = async (
        fileId,
        chunkIndex,
        chunkSize,
        contentHash,
        uploadToken,
    ) => {
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
            throw new Error(
                `Get upload spec failed: ${errData.error || res.statusText}`,
            );
        }
        return res.json();
    };

    /**
     * 使用 XHR 上传数据（支持进度回调）
     */
    const uploadWithXHR = (uploadSpec, data, onProgress) => {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress(e.loaded);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else {
                    reject(new Error(`Upload failed: ${xhr.status}`));
                }
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
                form.append(uploadSpec.fieldName || "file", new Blob([data]));
                xhr.send(form);
            } else {
                xhr.send(data);
            }
        });
    };

    /**
     * 通知服务端分片上传完成
     */
    const notifyChunkComplete = async (
        fileId,
        chunkIndex,
        chunkFileId,
        uploadId,
        contentHash,
        uploadToken,
    ) => {
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
            console.warn(
                `Complete notification for chunk ${chunkIndex} failed`,
            );
        }
    };

    /**
     * 完成整个上传
     */
    const finalizeUpload = async (fileId, fileMeta, chunkIds, uploadToken) => {
        await fetch("/api/upload/complete", {
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
    };

    const processAndUpload = async () => {
        if (!file) return;

        if (file.size > serverConfig.maxFileSize) {
            error = `文件大小超过限制。最大支持 ${formatBytes(serverConfig.maxFileSize)}。`;
            return;
        }

        view = "processing";
        error = "";
        statusInfo = {
            action: "正在初始化上传...",
            size: "",
            speed: "",
            eta: "",
        };

        try {
            // 1. 初始化上传
            const { fileId, uploadToken } = await initUpload(file.size);

            // 2. 准备加密
            const masterKeyStr = await generateMasterKey();
            const masterKey = await importMasterKey(masterKeyStr);
            const baseIv = window.crypto.getRandomValues(new Uint8Array(12));
            const keyHash = await hashData(masterKeyStr);

            const totalChunks = Math.ceil(file.size / serverConfig.chunkSize);
            const totalBytes = file.size;
            let uploadedBytes = 0;
            const speedTracker = new SpeedTracker(10000);
            const uploadedChunkIds = [];

            const updateProgress = () => {
                const speed = speedTracker.speed();
                const eta =
                    speed > 0 ? (totalBytes - uploadedBytes) / speed : 0;
                progress = Math.round((uploadedBytes / totalBytes) * 100);
                statusInfo = {
                    action: "正在上传",
                    size: `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`,
                    speed: speed > 0 ? formatSpeed(speed) : "",
                    eta: eta > 0 ? formatETA(eta) : "",
                };
            };

            statusInfo = {
                action: "准备上传",
                size: `${totalChunks} 个分块`,
                speed: "",
                eta: "",
            };

            // 3. 逐块加密并上传
            for (let i = 0; i < totalChunks; i++) {
                const start = i * serverConfig.chunkSize;
                const chunkBuffer = await file
                    .slice(
                        start,
                        Math.min(start + serverConfig.chunkSize, file.size),
                    )
                    .arrayBuffer();
                const encryptedChunk = await encryptChunk(
                    chunkBuffer,
                    masterKey,
                    baseIv,
                    i,
                );
                const contentHash = await computeHash(encryptedChunk);

                const chunkFileId = await withRetry(async () => {
                    const bytesBeforeAttempt = uploadedBytes;
                    let chunkUploaded = 0;

                    try {
                        const { uploadSpec, chunkFileId, uploadId } =
                            await getUploadSpec(
                                fileId,
                                i,
                                encryptedChunk.byteLength,
                                contentHash,
                                uploadToken,
                            );

                        await uploadWithXHR(
                            uploadSpec,
                            encryptedChunk,
                            (loaded) => {
                                const delta = loaded - chunkUploaded;
                                chunkUploaded = loaded;
                                uploadedBytes += delta;
                                speedTracker.record(delta);
                                updateProgress();
                            },
                        );

                        await notifyChunkComplete(
                            fileId,
                            i,
                            chunkFileId,
                            uploadId,
                            contentHash,
                            uploadToken,
                        );
                        return chunkFileId;
                    } catch (err) {
                        uploadedBytes = bytesBeforeAttempt;
                        updateProgress();
                        throw err;
                    }
                });

                uploadedChunkIds.push({ index: i, fileId: chunkFileId });
            }

            // 4. 完成上传
            statusInfo = {
                action: "正在完成上传...",
                size: "",
                speed: "",
                eta: "",
            };

            const sensitiveMeta = {
                name: file.name,
                type: file.type || "application/octet-stream",
            };
            const encryptedMeta = await encryptSensitiveMeta(
                masterKey,
                baseIv,
                sensitiveMeta,
            );

            const fileMeta = {
                size: file.size,
                iv: Array.from(baseIv),
                keyHash,
                createdAt: Date.now(),
                totalChunks,
                encryptedMeta,
            };

            await finalizeUpload(
                fileId,
                fileMeta,
                uploadedChunkIds,
                uploadToken,
            );

            shareLink = `${window.location.origin}${window.location.pathname}?f=${fileId}#${masterKeyStr}`;
            progress = 100;
            view = "success";
        } catch (err) {
            console.error(err);
            error = "上传失败：" + err.message;
            view = "home";
        }
    };

    // 4. Download and Decrypt (Real Implementation)

    /**
     * 获取 chunk URL（统一端点，服务端自动处理直链/转发）
     */
    const getChunkURL = (chunkIndex) => {
        return `/api/file/${urlParams.id}/chunk/${chunkIndex}`;
    };

    /**
     * 从 URL 读取数据流并返回完整数据
     * 浏览器会自动跟随 302 重定向
     */
    const fetchWithProgress = async (url, onProgress) => {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`下载失败: ${res.status}`);
        }

        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            received += value.byteLength;
            onProgress(value.byteLength, received);
        }

        // 合并所有块
        const buffer = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return buffer;
    };

    const handleDownload = async () => {
        if (!metaData || !urlParams.key || !urlParams.id) return;

        statusInfo = { action: "准备下载...", size: "", speed: "", eta: "" };
        view = "processing";
        progress = 0;

        try {
            const masterKey = await importMasterKey(urlParams.key);
            const baseIv = new Uint8Array(metaData.iv);
            const totalBytes = metaData.size;
            const speedTracker = new SpeedTracker(2000);

            let downloadedBytes = 0;

            const updateProgress = (chunkBytes, totalDownloaded) => {
                speedTracker.record(chunkBytes);
                downloadedBytes = totalDownloaded;

                const speed = speedTracker.speed();
                const remaining = totalBytes - downloadedBytes;
                const eta = speed > 0 ? remaining / speed : 0;

                progress = Math.round((downloadedBytes / totalBytes) * 100);
                statusInfo = {
                    action: "正在下载",
                    size: `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`,
                    speed: speed > 0 ? formatSpeed(speed) : "",
                    eta: eta > 0 ? formatETA(eta) : "",
                };
            };

            // 打开文件保存对话框
            let fileHandle;
            try {
                fileHandle = await showSaveFilePicker({
                    suggestedName: metaData.name,
                    types: [
                        {
                            description: "Files",
                            accept: {
                                [metaData.type || "application/octet-stream"]:
                                    [],
                            },
                        },
                    ],
                });
            } catch (e) {
                if (e.name === "AbortError") {
                    view = "download";
                    statusInfo = { action: "", size: "", speed: "", eta: "" };
                    return;
                }
                throw e;
            }

            const writable = await fileHandle.createWritable();

            try {
                let cumulativeBytes = 0;
                for (let i = 0; i < metaData.totalChunks; i++) {
                    const chunkBaseBytes = cumulativeBytes;

                    const decryptedBuffer = await withRetry(async () => {
                        downloadedBytes = chunkBaseBytes; // 重试时重置进度

                        const url = getChunkURL(i);
                        const encryptedData = await fetchWithProgress(
                            url,
                            (bytes, total) =>
                                updateProgress(bytes, chunkBaseBytes + total),
                        );

                        return await decryptChunk(
                            encryptedData,
                            masterKey,
                            baseIv,
                            i,
                        );
                    });

                    await writable.write(new Uint8Array(decryptedBuffer));
                    cumulativeBytes += decryptedBuffer.byteLength;
                }

                await writable.close();
            } catch (err) {
                await writable.abort();
                throw err;
            }

            view = "download";
            statusInfo = { action: "", size: "", speed: "", eta: "" };
        } catch (err) {
            console.error(err);
            error = "下载/解密失败：" + err.message;
            view = "download";
        }
    };

    function handleFileChange(e) {
        if (e.target.files && e.target.files[0]) {
            file = e.target.files[0];
        }
    }

    function copyLink() {
        navigator.clipboard.writeText(shareLink);
        copied = true;
        setTimeout(() => (copied = false), 2000);
    }
</script>

<div
    class="min-h-screen bg-[#0b0e14] text-slate-200 font-sans selection:bg-red-500/30"
>
    <nav
        class="border-b border-white/5 bg-[#0b0e14]/80 backdrop-blur-md sticky top-0 z-50"
    >
        <div
            class="max-w-6xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between"
        >
            <div
                class="flex items-center gap-2 group cursor-pointer"
                onclick={() =>
                    (window.location.href = window.location.pathname)}
                onkeydown={(e) =>
                    e.key === "Enter" &&
                    (window.location.href = window.location.pathname)}
                role="button"
                tabindex="0"
            >
                <div
                    class="w-7 h-7 sm:w-8 sm:h-8 bg-red-600 rounded-lg flex items-center justify-center shadow-lg shadow-red-600/20 group-hover:rotate-12 transition-transform"
                >
                    <Shield class="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                </div>
                <span
                    class="font-black text-lg sm:text-xl tracking-tighter text-white"
                    >MEGA<span class="text-red-600">SHARE</span></span
                >
            </div>
            <div
                class="flex items-center gap-2 sm:gap-4 text-[10px] sm:text-xs font-medium text-slate-500"
            >
                <span class="flex items-center gap-1 sm:gap-1.5">
                    <span
                        class="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-green-500"
                    ></span>
                    <span class="hidden xs:inline">端到端</span>加密已就绪
                </span>
            </div>
        </div>
    </nav>

    <main
        class="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-20 pb-24 sm:pb-28"
    >
        {#if error}
            <div
                class="mb-8 p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-2xl flex items-center gap-3"
            >
                <CircleAlert class="w-5 h-5" />
                <span class="text-sm font-semibold">{error}</span>
            </div>
        {/if}

        {#if view === "home"}
            <div class="space-y-16">
                <div class="text-center space-y-4 sm:space-y-6">
                    <h1
                        class="text-3xl sm:text-4xl md:text-6xl font-black text-white leading-tight"
                    >
                        隐私分享，<br />从未如此<span
                            class="text-red-600 underline underline-offset-4 sm:underline-offset-8 decoration-2 sm:decoration-4"
                            >强大</span
                        >。
                    </h1>
                    <p
                        class="text-slate-400 text-base sm:text-lg md:text-xl max-w-2xl mx-auto px-2"
                    >
                        端到端加密传输。最高支持 20GB
                        传输，无需注册，密钥仅归您所有。文件将在 24
                        小时后自动销毁。
                    </p>
                </div>

                <div class="relative group">
                    <input
                        type="file"
                        id="file-up"
                        class="hidden"
                        onchange={handleFileChange}
                    />
                    <label
                        for="file-up"
                        class="block border-2 border-dashed border-white/10 rounded-2xl sm:rounded-[2.5rem] p-6 sm:p-12 md:p-20 text-center transition-all cursor-pointer hover:border-red-600/50 hover:bg-white/2"
                    >
                        {#if !file}
                            <div class="space-y-4 sm:space-y-6">
                                <div
                                    class="w-16 h-16 sm:w-20 sm:h-20 bg-white/5 rounded-2xl sm:rounded-3xl flex items-center justify-center mx-auto"
                                >
                                    <Upload
                                        class="w-8 h-8 sm:w-10 sm:h-10 text-slate-400 group-hover:text-red-600"
                                    />
                                </div>
                                <div class="space-y-1 sm:space-y-2">
                                    <p
                                        class="text-xl sm:text-2xl font-bold text-white"
                                    >
                                        开始安全上传
                                    </p>
                                    <p
                                        class="text-sm sm:text-base text-slate-500"
                                    >
                                        点击或拖拽文件至此 <span
                                            class="hidden sm:inline"
                                            >(最大 20GB)</span
                                        >
                                    </p>
                                </div>
                            </div>
                        {:else}
                            <div
                                class="space-y-6 sm:space-y-8 animate-in zoom-in-95"
                            >
                                <div
                                    class="flex items-center justify-center gap-3 sm:gap-4"
                                >
                                    <div
                                        class="w-12 h-12 sm:w-16 sm:h-16 bg-red-600/10 text-red-600 rounded-xl sm:rounded-2xl flex items-center justify-center shrink-0"
                                    >
                                        <FileIcon
                                            class="w-6 h-6 sm:w-8 sm:h-8"
                                        />
                                    </div>
                                    <div class="text-left min-w-0">
                                        <p
                                            class="text-base sm:text-xl font-bold text-white truncate max-w-50 sm:max-w-xs"
                                        >
                                            {file.name}
                                        </p>
                                        <p
                                            class="text-slate-500 text-xs sm:text-sm"
                                        >
                                            {(
                                                file.size /
                                                (1024 * 1024)
                                            ).toFixed(2)} MB
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onclick={(e) => {
                                        e.preventDefault();
                                        processAndUpload();
                                    }}
                                    class="w-full sm:w-auto bg-red-600 hover:bg-red-700 text-white px-6 sm:px-10 py-3 sm:py-4 rounded-xl sm:rounded-2xl font-black text-base sm:text-lg shadow-xl shadow-red-600/20 transition-all flex items-center justify-center gap-2 sm:gap-3 mx-auto"
                                >
                                    <Lock class="w-4 h-4 sm:w-5 sm:h-5" /> 加密并获取链接
                                </button>
                            </div>
                        {/if}
                    </label>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-8">
                    <div
                        class="p-4 sm:p-6 bg-white/3 border border-white/5 rounded-2xl sm:rounded-3xl space-y-2 sm:space-y-3 flex sm:block items-center gap-4"
                    >
                        <div class="text-red-600 shrink-0">
                            <Lock class="w-5 h-5 sm:w-6 sm:h-6" />
                        </div>
                        <div>
                            <h3
                                class="font-bold text-white text-sm sm:text-base"
                            >
                                AES-256-GCM 加密
                            </h3>
                            <p class="text-xs sm:text-sm text-slate-500">
                                端到端加密，抗量子计算攻击
                            </p>
                        </div>
                    </div>
                    <div
                        class="p-4 sm:p-6 bg-white/3 border border-white/5 rounded-2xl sm:rounded-3xl space-y-2 sm:space-y-3 flex sm:block items-center gap-4"
                    >
                        <div class="text-red-600 shrink-0">
                            <HardDrive class="w-5 h-5 sm:w-6 sm:h-6" />
                        </div>
                        <div>
                            <h3
                                class="font-bold text-white text-sm sm:text-base"
                            >
                                超大容量
                            </h3>
                            <p class="text-xs sm:text-sm text-slate-500">
                                优化流式处理支持 20GB 传输
                            </p>
                        </div>
                    </div>
                    <div
                        class="p-4 sm:p-6 bg-white/3 border border-white/5 rounded-2xl sm:rounded-3xl space-y-2 sm:space-y-3 flex sm:block items-center gap-4"
                    >
                        <div class="text-red-600 shrink-0">
                            <Share2 class="w-5 h-5 sm:w-6 sm:h-6" />
                        </div>
                        <div>
                            <h3
                                class="font-bold text-white text-sm sm:text-base"
                            >
                                即时分享
                            </h3>
                            <p class="text-xs sm:text-sm text-slate-500">
                                免注册即开即用，隐私无痕
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        {/if}

        {#if view === "processing"}
            <div
                class="max-w-2xl mx-auto py-8 sm:py-12 text-center space-y-6 sm:space-y-8"
            >
                <div class="relative w-24 h-24 sm:w-32 sm:h-32 mx-auto">
                    <div
                        class="absolute inset-0 border-4 border-white/5 rounded-full"
                    ></div>
                    <div
                        class="absolute inset-0 border-4 border-red-600 rounded-full border-t-transparent animate-spin"
                    ></div>
                    <div
                        class="absolute inset-0 flex items-center justify-center font-black text-lg sm:text-xl text-white"
                    >
                        {progress}%
                    </div>
                </div>
                <div class="text-center space-y-1">
                    <h2 class="text-xl font-bold text-white">
                        {statusInfo.action || "处理中"}...
                    </h2>

                    {#if statusInfo.size}
                        <div
                            class="items-center justify-center gap-4 text-sm font-mono text-slate-400 bg-white/5 py-2 px-4 rounded-lg inline-flex border border-white/5 mt-2"
                        >
                            <span>
                                {statusInfo.size}
                            </span>
                            {#if statusInfo.speed}
                                <span class="w-px h-3 bg-white/10"></span>
                                <span class="text-emerald-400">
                                    {statusInfo.speed}
                                </span>
                            {/if}
                        </div>
                    {/if}
                    {#if statusInfo.eta}
                        <p
                            class="text-xs text-slate-600 mt-2 animate-subtle-pulse"
                        >
                            剩余时间: 约 {statusInfo.eta}
                        </p>
                    {/if}
                </div>
            </div>
        {/if}

        {#if view === "success"}
            <div
                class="bg-white/3 border border-white/5 p-5 sm:p-8 md:p-12 rounded-2xl sm:rounded-[2.5rem] space-y-6 sm:space-y-10 animate-in slide-in-from-bottom-8"
            >
                <div class="space-y-2 text-center">
                    <div
                        class="flex items-center justify-center gap-2 sm:gap-3 text-green-500 font-bold text-sm sm:text-base"
                    >
                        <Check class="w-5 h-5 sm:w-6 sm:h-6" />
                        <span>加密完成</span>
                    </div>
                    <h2 class="text-2xl sm:text-3xl font-black text-white">
                        文件链接已准备好
                    </h2>
                </div>

                <div
                    class="p-4 sm:p-6 bg-black rounded-2xl sm:rounded-3xl border border-white/10 space-y-3 sm:space-y-4"
                >
                    <div
                        class="flex items-center justify-between text-[9px] sm:text-[10px] font-black uppercase text-slate-500 tracking-wider sm:tracking-widest"
                    >
                        <span
                            >分享链接 <span class="hidden sm:inline"
                                >(包含解密密钥)</span
                            ></span
                        >
                        <span class="text-red-500">私密信息</span>
                    </div>
                    <div class="flex flex-col sm:flex-row gap-2 sm:gap-3">
                        <input
                            readonly
                            value={shareLink}
                            class="flex-1 bg-white/5 border border-white/10 px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg sm:rounded-xl text-xs sm:text-sm font-mono text-slate-300 outline-none"
                        />
                        <button
                            onclick={copyLink}
                            class={`w-full sm:w-auto px-6 py-2.5 sm:py-3 rounded-lg sm:rounded-xl font-bold transition-all ${copied ? "bg-green-600 text-white" : "bg-white text-black"}`}
                        >
                            {copied ? "已复制" : "复制链接"}
                        </button>
                    </div>
                </div>

                <div
                    class="flex items-start gap-2 sm:gap-3 p-3 sm:p-4 bg-red-600/5 rounded-xl sm:rounded-2xl border border-red-600/10"
                >
                    <CircleAlert
                        class="w-4 h-4 sm:w-5 sm:h-5 text-red-600 mt-0.5 shrink-0"
                    />
                    <p
                        class="text-[11px] sm:text-xs text-slate-400 leading-relaxed"
                    >
                        密钥仅存储在此链接中。丢失链接将无法恢复数据。文件 24
                        小时后自动销毁。
                    </p>
                </div>

                <button
                    onclick={() => window.location.reload()}
                    class="text-slate-400 hover:text-white font-bold flex items-center gap-2 mx-auto text-sm sm:text-base"
                >
                    继续分享其他文件 <ChevronRight class="w-4 h-4" />
                </button>
            </div>
        {/if}

        {#if view === "download" && !statusInfo.action}
            <div
                class="max-w-xl mx-auto bg-white/3 border border-white/5 p-6 sm:p-10 rounded-2xl sm:rounded-[2.5rem] text-center space-y-6 sm:space-y-10 animate-in fade-in zoom-in-95"
            >
                <div
                    class="w-16 h-16 sm:w-24 sm:h-24 bg-red-600/10 text-red-600 rounded-2xl sm:rounded-4xl flex items-center justify-center mx-auto shadow-inner"
                >
                    <LockOpen class="w-8 h-8 sm:w-12 sm:h-12" />
                </div>
                <h2 class="text-2xl sm:text-3xl font-black text-white">
                    收到加密文件
                </h2>
                {#if metaData}
                    {@const expiryTime =
                        metaData.createdAt + 24 * 60 * 60 * 1000}
                    {@const remaining = expiryTime - Date.now()}
                    {@const timeLeft = formatTimeRemaining(remaining)}
                    {#if timeLeft}
                        <div
                            class="flex items-center justify-center gap-2 text-xs sm:text-sm text-amber-500/80"
                        >
                            <Clock class="w-4 h-4" />
                            <span>文件将在 {timeLeft} 后过期</span>
                        </div>
                    {/if}
                    <div
                        class="bg-black/40 p-4 sm:p-6 rounded-2xl sm:rounded-3xl border border-white/5 flex items-center gap-3 sm:gap-4 text-left"
                    >
                        <div
                            class="w-10 h-10 sm:w-12 sm:h-12 bg-white/5 rounded-lg sm:rounded-xl flex items-center justify-center shrink-0"
                        >
                            <FileIcon
                                class="w-5 h-5 sm:w-6 sm:h-6 text-slate-400"
                            />
                        </div>
                        <div class="flex-1 min-w-0">
                            <p
                                class="font-bold text-white truncate text-sm sm:text-base"
                            >
                                {metaData.name}
                            </p>
                            <p
                                class="text-[10px] sm:text-xs text-slate-500 uppercase tracking-tighter"
                            >
                                大小: {(metaData.size / (1024 * 1024)).toFixed(
                                    2,
                                )} MB
                            </p>
                        </div>
                    </div>
                {:else}
                    <div class="text-slate-500 text-sm">加载元数据中...</div>
                {/if}
                <button
                    onclick={handleDownload}
                    disabled={!metaData}
                    class="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white py-4 sm:py-5 rounded-xl sm:rounded-2xl font-black text-lg sm:text-xl transition-all shadow-xl shadow-red-600/20 flex items-center justify-center gap-2 sm:gap-3"
                >
                    <Download class="w-5 h-5 sm:w-6 sm:h-6" /> 解密并保存文件
                </button>
            </div>
        {/if}
    </main>

    <footer
        class="fixed bottom-0 left-0 right-0 py-3 sm:py-4 px-4 sm:px-6 bg-[#0b0e14]/95 border-t border-white/5 backdrop-blur-sm z-40 text-center"
    >
        <p
            class="text-[8px] sm:text-[10px] text-slate-600 uppercase tracking-wider sm:tracking-widest font-medium"
        >
            Powered by Web Crypto API • AES-256-GCM
        </p>
    </footer>
</div>
