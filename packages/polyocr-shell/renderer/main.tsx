/**
 * React entry point. Mounts <App /> into #root.
 *
 * Strict mode is on — React 18's double-invocation of effects in dev
 * surfaces missing cleanups early, which matters here because the shell
 * subscribes to IPC events (`polyocr:stream:result`) and we need those
 * subscriptions to clean up properly between page transitions.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  // Should never happen — index.html ships the #root div. Crashing
  // loudly here is more useful than silently failing to mount.
  throw new Error('PolyOCR renderer: #root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
