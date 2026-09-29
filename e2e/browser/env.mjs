// Shared by playwright.config.mjs and the specs (both are evaluated in every worker).
//
//   E2E_BASE_URL          signaling server to test; unset = spawn the local Express server
//   E2E_SERVER_PASSWORD   its server password, if any (locally: the password the spawned
//                         server gets; default is a non-ASCII test password, "" = open server)
export const REMOTE = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
export const SIGNAL_PORT = Number(process.env.E2E_SIGNAL_PORT ?? 47787);
export const DOCS_PORT = Number(process.env.E2E_DOCS_PORT ?? 47173);
export const SIGNAL_URL = REMOTE ?? `http://127.0.0.1:${SIGNAL_PORT}`;
export const DOCS_URL = `http://127.0.0.1:${DOCS_PORT}/`;
export const SERVER_PASSWORD = process.env.E2E_SERVER_PASSWORD ?? (REMOTE ? "" : "e2e-sërver-pässword");
// The chat app's built-in default server. Tests against another target intercept it,
// so local runs never touch production (see Peer.open).
export const DEFAULT_SIGNAL_URL = "https://defuss-webrtc.vercel.app";
