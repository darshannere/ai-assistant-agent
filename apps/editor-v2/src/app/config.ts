// Backend connection config — reads from Vite env vars at build time.
// Local dev: uses .env (VITE_BACKEND_URL=http://localhost:8000)
// Production: uses .env.production or Vercel env vars

const rawBackendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';
const rawSignalingUrl = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:4444';

// Strip trailing slash
export const BACKEND_URL = rawBackendUrl.replace(/\/+$/, '');

// WebSocket URL: derive from BACKEND_URL (http→ws, https→wss)
export const WS_URL = BACKEND_URL.replace(/^http/, 'ws');

// WebRTC signaling server
export const SIGNALING_URL = rawSignalingUrl;
