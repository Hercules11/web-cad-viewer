import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 项目站点挂在子路径 (/<repo>/) 下, 使用相对 base 保证资源可达
  base: './',
  // libredwg-web 内含 Emscripten WASM glue, 不做依赖预构建, 避免破坏其 worker/wasm 加载
  optimizeDeps: {
    exclude: ['@mlightcad/libredwg-web'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2048,
  },
});

