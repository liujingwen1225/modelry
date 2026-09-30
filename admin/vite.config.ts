import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../internal/webui/dist/', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/admin/api': {
        target: process.env.MODELRY_RUNTIME_URL ?? 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
    fs: {
      allow: [projectDirectory, fileURLToPath(new URL('../', import.meta.url))],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
    // 页面测试在 jsdom 下渲染整棵 Admin 页面树，并行满载时首个断言前
    // 的环境构建可能超过 vitest 默认 5s；这里放宽超时以避免与产品逻辑
    // 无关的假失败（真实断言失败仍会照常报出）。
    testTimeout: 20000,
  },
});
