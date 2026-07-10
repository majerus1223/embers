// Grafana Faro RUM bootstrap.
//
// Runs as early as possible (loaded in <head>, before the app scripts) so it
// captures errors, web vitals, console output and navigation from the very
// start of the page lifecycle.
//
// Config (collector URL, app version, environment) is injected by the server
// via /faro-config.js as `window.FARO_CONFIG` — nothing is hardcoded here.
(function () {
  var cfg = window.FARO_CONFIG || {};

  if (!cfg.url) {
    console.warn('[faro] no collector URL configured (FARO_CONFIG.url is empty) — RUM disabled');
    return;
  }

  var sdk = window.GrafanaFaroWebSdk;
  var tracing = window.GrafanaFaroWebTracing;
  if (!sdk || typeof sdk.initializeFaro !== 'function') {
    console.error('[faro] Faro Web SDK failed to load — RUM disabled');
    return;
  }

  var instrumentations = sdk.getWebInstrumentations(); // errors, web vitals, console, view/navigation
  if (tracing && tracing.TracingInstrumentation) {
    instrumentations.push(new tracing.TracingInstrumentation()); // OTel web tracing → distributed traces
  }

  var faro = sdk.initializeFaro({
    url: cfg.url,
    app: {
      name: cfg.name || 'embers',
      version: cfg.version || '0.0.0',
      environment: cfg.environment || 'production',
    },
    instrumentations: instrumentations,
  });
  window.faro = faro;

  initSessionReplay(faro);

  // ---------------------------------------------------------------------------
  // Session replay via rrweb.
  //
  // We record the DOM with rrweb and ship batches through Faro as logs encoded
  // as  rrweb:<base64(JSON events)>  — the exact format the replay reader
  // consumes. Faro attaches session_id/app_name/job so the reader can group a
  // session and correlate it with the rest of the telemetry.
  // ---------------------------------------------------------------------------
  function initSessionReplay(faro) {
    if (!window.rrweb || typeof window.rrweb.record !== 'function') {
      console.warn('[faro] rrweb not loaded — session replay disabled');
      return;
    }

    var buffer = [];
    var flushTimer = null;
    var MAX_BATCH = 50;        // flush after this many events
    var FLUSH_INTERVAL = 5000; // ...or at least this often (ms)

    // UTF-8 safe base64 (plain btoa throws on non-Latin1 chars in the DOM).
    function toBase64(str) {
      var bytes = new TextEncoder().encode(str);
      var bin = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    }

    // Globally increasing chunk sequence. Seeded from Date.now() so it keeps
    // climbing across page navigations within a session (per-page counters
    // would collide) — required by the plugin's replay ordering.
    var seq = Date.now();

    function currentView() {
      try {
        var v = faro.api.getView && faro.api.getView();
        if (v && v.name) return v.name;
      } catch (e) {}
      return window.location.pathname || 'default';
    }

    function flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!buffer.length) return;
      var events = buffer;
      buffer = [];

      // Exact wire contract the RUM plugin expects (RUNBOOK §4): a Faro log
      // (kind=log) whose message is  rrweb:<base64(JSON events)>  PLUS a context
      // { rrweb:'1', seq, view } that lands as context_rrweb/context_seq/
      // context_view — the plugin detects replay via context_rrweb='1'.
      // Faro auto-attaches session_id / app_name / job.
      faro.api.pushLog(['rrweb:' + toBase64(JSON.stringify(events))], {
        level: 'info',
        context: {
          rrweb: '1',
          seq: String(seq++),
          view: currentView(),
        },
      });
    }

    window.rrweb.record({
      emit: function (event) {
        buffer.push(event);
        if (buffer.length >= MAX_BATCH) {
          flush();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flush, FLUSH_INTERVAL);
        }
      },
    });

    // Best-effort flush of anything still buffered when the user leaves.
    window.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  }
})();
