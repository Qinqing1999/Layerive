import type { ProxyOptions } from 'vite';

const proxyTarget = 'http://127.0.0.1:8788';
const proxyOpts: ProxyOptions = {
  target: proxyTarget,
  changeOrigin: true,
  // 移除 Origin 头，使后端 assertLocalUiRequest 的 Origin 检查不被外部 IP 触发
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin');
    });
  },
};

export default {
  server: {
    port: 5173,
    strictPort: true,
    host: '0.0.0.0',
    proxy: {
      '/api': proxyOpts,
      '/files': proxyOpts,
      // Gallery artwork is served from data/gallery, not dist/. Without this
      // the SPA fallback answers every thumbnail with index.html.
      '/gallery-files': proxyOpts,
    },
  },
};
