// Pairing QR. Bridle is mostly a command-line facility, so by default it prints
// a scannable QR straight to the terminal. Optionally it can pop a small native
// webview window showing the same code (per the spec) — that path is lazy and
// fully optional, so the binary still runs headless without the webview dep.

import QRCode from 'qrcode';

/** Render the QR as ANSI blocks for the terminal. */
export async function terminalQR(url) {
  return QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

/**
 * Try to open a native webview window with the QR. Returns true on success.
 * Falls back (returns false) if `webview-bun` isn't installed or fails to load,
 * so callers can keep using the terminal QR.
 */
export async function openWebviewQR(url, { title = 'Bridle — scan to tether' } = {}) {
  let Webview;
  try {
    ({ Webview } = await import('webview-bun'));
  } catch {
    return false; // optional dependency not present — that's fine
  }
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 });
    const html = pairingPage({ title, url, dataUrl });
    const wv = new Webview();
    wv.title = title;
    wv.setHTML(html);
    // run() blocks until the window closes; caller decides whether to await.
    wv.run();
    return true;
  } catch {
    return false;
  }
}

function pairingPage({ title, url, dataUrl }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #0b0b0f; color: #e8e8ef; text-align: center; }
  .card { padding: 2rem 2.5rem; }
  h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: .02em; margin: 0 0 1rem; }
  img { width: 320px; height: 320px; border-radius: 16px; background: #fff; padding: 12px; }
  code { display: block; margin-top: 1rem; opacity: .7; font-size: .85rem; word-break: break-all; }
</style></head>
<body><div class="card">
  <h1>Scan with your phone to tether</h1>
  <img alt="pairing QR" src="${dataUrl}" />
  <code>${url}</code>
</div></body></html>`;
}
