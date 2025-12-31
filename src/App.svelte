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
    import {
        formatSpeed,
        formatBytes,
        formatETA,
        formatTimeRemaining,
        SpeedTracker,
    } from "./lib/utils.js";
    import { decryptSensitiveMeta, hashData } from "./lib/crypto.js";
    import { FileUploader } from "./lib/uploader.js";
    import { FileDownloader } from "./lib/downloader.js";
    import { destroyCryptoWorker } from "./lib/worker-bridge.js";

    // ===== State =====
    let serverConfig = $state({
        supportsDirectUrl: true,
        supportsDirectUpload: true,
        chunkSize: 128 * 1024 * 1024,
        maxFileSize: 20 * 1024 * 1024 * 1024,
    });

    let view = $state("home");
    let file = $state(null);
    let progress = $state(0);
    let statusInfo = $state({ action: "", size: "", speed: "", eta: "" });
    let shareLink = $state("");
    let error = $state("");
    let copied = $state(false);
    let metaData = $state(null);
    let urlParams = $state({ id: "", key: "" });

    // ===== Initialization =====
    $effect(() => {
        if (typeof window === "undefined") return;

        // Cleanup old service workers
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.getRegistrations().then((registrations) => {
                for (const registration of registrations) {
                    registration.unregister();
                }
            });
        }

        // Parse URL params
        const params = new URLSearchParams(window.location.search);
        const id = params.get("f");
        const key = window.location.hash.substring(1);

        if (id && key && (urlParams.id !== id || urlParams.key !== key)) {
            urlParams = { id, key };
            view = "download";
            fetchMetadata(id, key);
        }

        // Fetch server config
        fetchServerConfig();

        return () => {
            // 在组件销毁时终止 worker
            destroyCryptoWorker();
        };
    });

    async function fetchServerConfig() {
        try {
            const res = await fetch("/api/config");
            if (res.ok) {
                serverConfig = await res.json();
            }
        } catch (err) {
            console.warn("Failed to fetch server config, using defaults", err);
        }
    }

    async function fetchMetadata(id, key) {
        try {
            const res = await fetch(`/api/file/${id}`);
            if (!res.ok) throw new Error("File not found");
            const data = await res.json();
            const rawMeta = data.metadata;

            // Verify key hash
            if (key && rawMeta.keyHash) {
                const inputKeyHash = await hashData(key);
                if (inputKeyHash !== rawMeta.keyHash) {
                    error = "解密密钥不正确。";
                    return;
                }
            }

            // Decrypt sensitive metadata
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
    }

    // ===== Upload Handler =====
    async function processAndUpload() {
        if (!file) return;

        if (file.size > serverConfig.maxFileSize) {
            error = `文件大小超过限制。最大支持 ${formatBytes(serverConfig.maxFileSize)}。`;
            return;
        }

        view = "processing";
        error = "";
        progress = 0;
        statusInfo = {
            action: "正在初始化上传...",
            size: "",
            speed: "",
            eta: "",
        };

        try {
            const uploader = new FileUploader(file, serverConfig);
            const speedTracker = new SpeedTracker(10000);

            const updateProgress = (bytes, total) => {
                speedTracker.record(bytes);
                const speed = speedTracker.speed();
                const remaining = uploader.totalBytes - uploader.uploadedBytes;
                const eta = speed > 0 ? remaining / speed : 0;

                progress = Math.round(
                    (uploader.uploadedBytes / uploader.totalBytes) * 100,
                );
                statusInfo = {
                    action: "正在上传",
                    size: `${formatBytes(uploader.uploadedBytes)} / ${formatBytes(uploader.totalBytes)}`,
                    speed: speed > 0 ? formatSpeed(speed) : "",
                    eta: eta > 0 ? formatETA(eta) : "",
                };
            };

            const onStatusUpdate = (update) => {
                statusInfo = { ...statusInfo, ...update };
            };

            const { fileId, masterKeyStr } = await uploader.upload(
                updateProgress,
                onStatusUpdate,
            );

            shareLink = `${window.location.origin}${window.location.pathname}?f=${fileId}#${masterKeyStr}`;
            progress = 100;
            view = "success";
        } catch (err) {
            console.error(err);
            error = "上传失败：" + err.message;
            view = "home";
        }
    }

    // ===== Download Handler =====
    async function handleDownload() {
        if (!metaData || !urlParams.key || !urlParams.id) return;

        statusInfo = { action: "准备下载...", size: "", speed: "", eta: "" };
        view = "processing";
        progress = 0;

        try {
            // Open file save dialog
            const fileHandle = await showSaveFilePicker({
                suggestedName: metaData.name,
                types: [
                    {
                        description: "Files",
                        accept: {
                            [metaData.type || "application/octet-stream"]: [],
                        },
                    },
                ],
            });

            const writable = await fileHandle.createWritable();
            const downloader = new FileDownloader(urlParams.id, metaData);
            const speedTracker = new SpeedTracker(2000);

            const updateProgress = (bytes, total) => {
                speedTracker.record(bytes);
                const speed = speedTracker.speed();
                const remaining =
                    downloader.totalBytes - downloader.downloadedBytes;
                const eta = speed > 0 ? remaining / speed : 0;

                progress = Math.round(
                    (downloader.downloadedBytes / downloader.totalBytes) * 100,
                );
                statusInfo = {
                    action: "正在下载",
                    size: `${formatBytes(downloader.downloadedBytes)} / ${formatBytes(downloader.totalBytes)}`,
                    speed: speed > 0 ? formatSpeed(speed) : "",
                    eta: eta > 0 ? formatETA(eta) : "",
                };
            };

            try {
                await downloader.download(
                    urlParams.key,
                    writable,
                    updateProgress,
                );
                await writable.close();
            } catch (err) {
                await writable.abort();
                throw err;
            }

            view = "download";
            statusInfo = { action: "", size: "", speed: "", eta: "" };
        } catch (err) {
            if (err.name === "AbortError") {
                view = "download";
                statusInfo = { action: "", size: "", speed: "", eta: "" };
                return;
            }
            console.error(err);
            error = "下载/解密失败：" + err.message;
            view = "download";
        }
    }

    // ===== UI Handlers =====
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
                                端到端加密，军用级加密
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
