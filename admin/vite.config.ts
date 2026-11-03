import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

const runtimeTarget = process.env.MODELRY_DEV_RUNTIME ?? 'http://127.0.0.1:8090'

/**
 * 开发时把 API 代理到真实 Go 运行时。
 *
 * 管理面按同源校验 Origin，因此代理会把 Origin 改写成运行时地址，
 * 让本地开发与单二进制部署走同一套安全语义。
 */
function apiProxy(): ProxyOptions {
  return {
    target: runtimeTarget,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyRequest) => {
        proxyRequest.setHeader('origin', runtimeTarget)
      })
    },
  }
}

/** 构建产物直接落进 Go 单二进制的 Embed 目录，保留 internal/webui 接缝。 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': apiProxy(),
      '/api': apiProxy(),
    },
  },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
})
