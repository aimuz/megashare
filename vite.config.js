import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // HTTPS 配置仅在 dev 模式且证书文件存在时启用
  const httpsConfig =
    command === "serve" && fs.existsSync("./localhost.key") && fs.existsSync("./localhost.crt")
      ? {
          key: fs.readFileSync("./localhost.key"),
          cert: fs.readFileSync("./localhost.crt"),
        }
      : undefined;

  return {
    plugins: [svelte(), tailwindcss()],
    server: {
      https: httpsConfig,
      proxy: {
        "/api": "http://localhost:18080",
      },
    },
  };
});
