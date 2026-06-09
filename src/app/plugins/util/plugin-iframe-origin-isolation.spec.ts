import { PLUGIN_IFRAME_SANDBOX } from './plugin-iframe.util';

/**
 * Characterization guard for issue #8209 (plugin isolation).
 *
 * The plugin UI iframe is loaded from a blob: URL created by the host
 * (`createPluginIframeUrl`) with `sandbox="… allow-same-origin …"`. A blob URL
 * inherits the creating context's origin, and `allow-same-origin` keeps that
 * origin instead of assigning an opaque one — so the iframe is SAME-ORIGIN with
 * the host and can read `window.parent` (e.g. a `window.ea`-style privileged
 * bridge), bypassing the postMessage boundary. The browser even warns: "an
 * iframe which has both allow-scripts and allow-same-origin can escape its
 * sandboxing".
 *
 * These tests document that today's sandbox does NOT isolate the iframe, and
 * that an opaque-origin (no allow-same-origin) iframe WOULD be isolated.
 *
 * IMPORTANT: the isolated variant is NOT a drop-in fix — on a packaged file://
 * build an opaque-origin iframe cannot load the blob:file:// URL at all (blank
 * plugin UI). A real fix needs `srcdoc` or an `app://` scheme; see the doc on
 * `PLUGIN_IFRAME_SANDBOX`. These tests run on Karma's http origin where the
 * reachability MECHANISM is the same (the bridge object itself only exists in
 * packaged Electron).
 */

const SENTINEL_KEY = '__EA_SENTINEL_8209__';

const probeParentReachability = (sandbox: string): Promise<boolean> => {
  // Inline script reads a property off window.parent. Reading a property
  // across an opaque/cross origin throws SecurityError → reported as false.
  const probeHtml =
    `<!doctype html><html><body><script>` +
    `var reachable = false;` +
    `try { reachable = typeof window.parent['${SENTINEL_KEY}'] !== 'undefined'; }` +
    `catch (e) { reachable = false; }` +
    `window.parent.postMessage({ __probe8209: true, reachable: reachable }, '*');` +
    `</scr` +
    `ipt></body></html>`;

  const blob = new Blob([probeHtml], { type: 'text/html' });
  const blobUrl = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', sandbox);
  iframe.src = blobUrl;

  return new Promise<boolean>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      iframe.remove();
      URL.revokeObjectURL(blobUrl);
    };
    const onMsg = (ev: MessageEvent): void => {
      if (ev.data && (ev.data as { __probe8209?: boolean }).__probe8209) {
        const reachable = !!(ev.data as { reachable?: boolean }).reachable;
        cleanup();
        resolve(reachable);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('plugin iframe origin probe timed out'));
    }, 3000);
    window.addEventListener('message', onMsg);
    document.body.appendChild(iframe);
  });
};

describe('plugin iframe origin isolation (#8209)', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>)[SENTINEL_KEY] =
      'host-privileged-bridge';
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[SENTINEL_KEY];
  });

  it('the current sandbox still includes allow-same-origin (accepted risk)', () => {
    // Dropping it isolates the iframe but breaks blob:file:// loading on
    // desktop (blank UI) — see the PLUGIN_IFRAME_SANDBOX doc. Revisit together.
    expect(PLUGIN_IFRAME_SANDBOX).toContain('allow-same-origin');
  });

  it('CURRENT sandbox (allow-same-origin) leaves the iframe able to read window.parent', async () => {
    const reachable = await probeParentReachability(PLUGIN_IFRAME_SANDBOX);
    // true = the iframe is NOT isolated from the host window (the #8209 hole).
    expect(reachable).toBe(true);
  });

  it('an opaque-origin iframe (no allow-same-origin) CANNOT read window.parent', async () => {
    const hardened = PLUGIN_IFRAME_SANDBOX.replace(/\s*allow-same-origin/, '');
    expect(hardened).not.toContain('allow-same-origin');
    const reachable = await probeParentReachability(hardened);
    // false = what isolation WOULD look like — but see the file:// blob caveat.
    expect(reachable).toBe(false);
  });
});
