import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// 页面级测试会渲染整棵 Admin 页面树并在 jsdom 中等待 i18n 加载与多路
// fetch 解析；并行满载时 1s 的默认异步断言超时会造成与产品逻辑无关的
// 假失败。放宽到 10s，真实回归仍会失败并给出可读差异。
configure({ asyncUtilTimeout: 10000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('lang');
});
