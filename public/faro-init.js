// Grafana Faro RUM bootstrap.
//
// Runs as early as possible (loaded in <head>, before the app scripts) so it
// captures errors, web vitals, console output and navigation from the very
// start of the page lifecycle.
//
// Config (collector URL, app version, environment) is injected by the server
// via /faro-config.js as `window.FARO_CONFIG` — nothing is hardcoded here.
//
// Beyond the stock SDK this file adds the optional signals the RUM plugin can
// visualize (see rum repo requirements2.md §3-4):
//   - pseudonymous user identity            → Users page / retention
//   - a view name per page (flames/designs) → Journeys funnels & pathways
//   - feature_flag_evaluated (flame-design) → Flags page
//   - click actions + rage/dead/error click → frustration signals
//   - rrweb session replay chunks           → Replay + Heatmaps
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

  // ---- View identity (one name per page → journey steps) -------------------
  // Set as the INITIAL view meta (not api.setView) so the page-load
  // faro.performance.navigation event carries view_name without also firing a
  // faro.view.changed — the RUM plugin counts either as a page view, so
  // emitting both would double-count.
  var VIEWS = { '/': 'flames', '/index.html': 'flames', '/designs': 'designs', '/designs.html': 'designs' };
  var viewName = VIEWS[window.location.pathname] || (window.location.pathname || '/');

  // ---- Pseudonymous user identity (stable per browser) ----------------------
  // The Users page attributes sessions/retention by user_id; without one every
  // session is anonymous and the page is empty. No auth here, so mint a stable
  // id per browser.
  function localGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function localSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) {}
  }
  var uid = localGet('embers:uid');
  if (!uid) {
    uid = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
    localSet('embers:uid', uid);
  }

  // ---- Flame design (per-browser choice, surfaced as a feature flag) --------
  var design = localGet('embers:design') || 'classic';
  window.EMBERS_DESIGN = design;

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
    // Initial metas: stamped on every signal from the first one (incl. the
    // session_start event, which the Users page keys identity off).
    user: { id: uid, username: 'ember-' + uid.slice(0, 4) },
    view: { name: viewName },
    instrumentations: instrumentations,
  });
  window.faro = faro;

  // Flags page: report the design this session sees, once per page load.
  faro.api.pushEvent('feature_flag_evaluated', { flag: 'flame-design', value: design });

  initClickTracking(faro);
  initSessionReplay(faro);

  // ---------------------------------------------------------------------------
  // Click actions + frustration signals (ported from the rum repo's
  // tools/rum-inject rig). Every click becomes a user_action_click event;
  // Datadog-style patterns become frustration events: 3+ clicks on one target
  // within 1s = rage; no DOM mutation or navigation within 500ms = dead; a JS
  // error within 1s = error click.
  // ---------------------------------------------------------------------------
  function initClickTracking(faro) {
    function selectorFor(el) {
      if (!el || !el.tagName) return 'unknown';
      var s = el.tagName.toLowerCase();
      if (el.id) return s + '#' + el.id;
      if (el.className && typeof el.className === 'string') {
        var c = el.className.trim().split(/\s+/)[0];
        if (c) s += '.' + c;
      }
      return s;
    }

    var lastClicks = []; // { tMs, selector }
    var mutated = false;
    new MutationObserver(function () {
      mutated = true;
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    document.addEventListener(
      'click',
      function (ev) {
        var target = ev.target && ev.target.closest ? ev.target.closest('button, a, input, [role="button"]') || ev.target : ev.target;
        var selector = selectorFor(target);
        var text = (target && (target.innerText || target.value || '') + '').trim().slice(0, 60);
        var now = Date.now();

        faro.api.pushEvent('user_action_click', { selector: selector, text: text, view: viewName });

        lastClicks = lastClicks.filter(function (c) { return now - c.tMs < 1000; });
        lastClicks.push({ tMs: now, selector: selector });
        var sameTarget = lastClicks.filter(function (c) { return c.selector === selector; }).length;
        if (sameTarget === 3) {
          faro.api.pushEvent('frustration_rage_click', { selector: selector, clicks: String(sameTarget) });
        }

        // Dead click: nothing changed and we didn't navigate within 500ms.
        // The flame canvas repaints every frame, so scope "changed" to real
        // DOM mutations (the observer above ignores canvas pixels anyway).
        mutated = false;
        var href = window.location.href;
        window.setTimeout(function () {
          if (!mutated && window.location.href === href) {
            faro.api.pushEvent('frustration_dead_click', { selector: selector });
          }
        }, 500);

        // Error click: a JS error fires within 1s of the click.
        var onError = function () {
          faro.api.pushEvent('frustration_error_click', { selector: selector });
          window.removeEventListener('error', onError);
        };
        window.addEventListener('error', onError);
        window.setTimeout(function () {
          window.removeEventListener('error', onError);
        }, 1000);
      },
      { capture: true, passive: true }
    );
  }

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
          view: viewName,
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
