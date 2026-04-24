// Host-gated stealth preload.
//
// Runs in every browser-pane webContents before any page script. Does
// NOTHING on the vast majority of sites — Kasada (KPSDK) and similar
// detectors fingerprint the presence of navigator.userAgentData /
// window.chrome patches as a stealth-tool signature, so on a "neutral"
// site we must look like a plain Chromium. On a small allowlist of
// sites that actively refuse non-Chrome browsers (notably Google's
// sign-in "This browser or app may not be secure"), we inject the
// minimum spoof needed to satisfy their client-side check.
(function () {
  try {
    const host = (location && location.hostname) || '';
    const NEEDS_SPOOF = [
      'accounts.google.com',
      'mail.google.com',
      'docs.google.com',
      'drive.google.com',
      'myaccount.google.com',
      'gmail.com',
    ];
    const matched = NEEDS_SPOOF.some(h => host === h || host.endsWith('.' + h));
    if (!matched) return;

    const m = String(navigator.userAgent || '').match(/Chrome\/(\d+)/);
    const major = m ? m[1] : '146';
    const full  = (process && process.versions && process.versions.chrome) || major + '.0.0.0';
    const brands = [
      { brand: 'Chromium',      version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not?A_Brand',   version: '99'  },
    ];
    const fullVersionList = [
      { brand: 'Chromium',      version: full },
      { brand: 'Google Chrome', version: full },
      { brand: 'Not?A_Brand',   version: '99.0.0.0' },
    ];
    const platform = String(navigator.userAgent || '').includes('Mac') ? 'macOS' : 'Unknown';
    const fakeUAD = {
      brands,
      mobile: false,
      platform,
      getHighEntropyValues(hints) {
        const out = { brands, mobile: false, platform };
        if (hints && hints.includes('fullVersionList'))  out.fullVersionList  = fullVersionList;
        if (hints && hints.includes('platformVersion'))  out.platformVersion  = '15.0.0';
        if (hints && hints.includes('architecture'))     out.architecture     = 'arm';
        if (hints && hints.includes('bitness'))          out.bitness          = '64';
        if (hints && hints.includes('model'))            out.model            = '';
        if (hints && hints.includes('uaFullVersion'))    out.uaFullVersion    = full;
        if (hints && hints.includes('wow64'))            out.wow64            = false;
        return Promise.resolve(out);
      },
      toJSON() { return { brands, mobile: false, platform }; },
    };
    try {
      Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgentData',
        { get() { return fakeUAD; }, configurable: true });
    } catch {}

    // Google's "secure browser" check probes the shape of window.chrome.
    // Real Chrome has at least {app, csi, loadTimes, runtime}. An embedded
    // webview typically has none of these — missing any of them is the
    // main tell that fires the "browser or app may not be secure" screen.
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function () {
        return { onloadT: Date.now(), pageT: 0, startE: Date.now(), tran: 15 };
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function () {
        return {
          commitLoadTime: 0, connectionInfo: 'h2', finishDocumentLoadTime: 0,
          finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0,
          navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: 0,
          startLoadTime: 0, wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
        };
      };
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: {},
        OnRestartRequiredReason: {},
        PlatformOs: { MAC: 'mac' },
      };
    }

    // Real Chrome on macOS reports at least ["en-US", "en"]; Electron
    // defaults to a single entry which is a minor but documented tell.
    try {
      if (!Array.isArray(navigator.languages) || navigator.languages.length < 2) {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'languages',
          { get() { return ['en-US', 'en']; }, configurable: true });
      }
    } catch {}
  } catch (_e) { /* no-op */ }
})();
