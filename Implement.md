# Implement.md — Instrument a web app for the `majerus-rum-app` Grafana plugin

This is a complete, no-detail-omitted guide to instrumenting a web app with
**Grafana Faro + rrweb session replay** so it shows up fully in the
`majerus-rum-app` RUM plugin (Sessions, Errors, Performance, Versions, Users,
Journeys, **Heatmaps**, **Replay**).

It was written from a working reference implementation (the `embers` app). If you
follow it exactly, every page of the plugin will populate.

> **The single most important, non-obvious part** is §5 (rrweb replay). Stock
> Faro does **not** ship rrweb, and the plugin detects replay by a specific
> **log shape + context fields**, not just "some rrweb data exists." Get §5
> exactly right or Replay and Heatmaps stay empty even though everything else works.

---

## 0. Architecture / data flow

```
Browser (Faro Web SDK + rrweb)
   │  HTTPS POST  https://<alloy-host>/collect
   ▼
Alloy  faro.receiver  (listens :12347, path /collect)
   │  logs  → loki.process "faro"  (stamps job/app_name/kind labels)
   │            └─► loki.write → Loki  (tenant X-Scope-OrgID: 1)
   │  traces → otelcol batch → Tempo
   ▼
Grafana  majerus-rum-app  reads Loki (rum-loki datasource) + Tempo (rum-tempo)
```

Key facts:
- The browser sends **one combined envelope** to `/collect`. The `faro.receiver`
  splits it into Loki logs and OTLP traces.
- **Nothing is hardcoded in client code** — the collector URL/version/environment
  is injected by the server at runtime (§3).
- The app **name must exactly match** the value selected in the plugin's app
  picker. Use a stable lowercase slug (e.g. `embers`).

---

## 1. Versions (pinned, known-good)

| Package | Version | CDN bundle | Browser global |
|---|---|---|---|
| `@grafana/faro-web-sdk` | `2.8.2` | `dist/bundle/faro-web-sdk.iife.js` | `GrafanaFaroWebSdk` |
| `@grafana/faro-web-tracing` | `2.8.2` | `dist/bundle/faro-web-tracing.iife.js` | `GrafanaFaroWebTracing` |
| `rrweb` | `2.1.0` | `dist/rrweb.umd.min.cjs` | `rrweb` |

- `faro-web-tracing` **must** be the same major/minor as `faro-web-sdk`.
- If you use a bundler instead of CDN, `import { initializeFaro, getWebInstrumentations } from '@grafana/faro-web-sdk'`, `import { TracingInstrumentation } from '@grafana/faro-web-tracing'`, and `import * as rrweb from 'rrweb'`. The logic in §4 is identical.

---

## 2. Load order (critical)

Faro must initialize **before your app code runs** so it captures the full page
lifecycle. Put these in `<head>`, in this order, before your app scripts:

```html
<!-- Grafana Faro RUM — loaded early, config injected by the backend -->
<script src="/faro-config.js"></script>
<script src="https://unpkg.com/@grafana/faro-web-sdk@2.8.2/dist/bundle/faro-web-sdk.iife.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@grafana/faro-web-tracing@2.8.2/dist/bundle/faro-web-tracing.iife.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/rrweb@2.1.0/dist/rrweb.umd.min.cjs" crossorigin="anonymous"></script>
<script src="/faro-init.js"></script>
```

> If your page is served over **HTTPS**, the collector URL must also be HTTPS
> (mixed-content is blocked). See §3/§7.

---

## 3. Server-side runtime config (do NOT hardcode the collector URL)

Expose the collector config to the browser at runtime so it comes from the
deployment environment, not the built asset. Example for a Node/Express server;
adapt to your stack (the only requirement is that `/faro-config.js` returns JS
that sets `window.FARO_CONFIG`).

```js
// --- config, read from env with sane fallbacks ---
const APP_VERSION = process.env.APP_VERSION || require('./package.json').version;
const FARO_CONFIG = {
  // Collector, fronted by the Alloy ingress (TLS-terminated) → faro.receiver.
  url: process.env.FARO_COLLECTOR_URL || 'https://alloy.sparks.majerus.dev/collect',
  // MUST exactly match the name selected in the plugin's app picker.
  name: 'embers',
  version: APP_VERSION,
  environment: process.env.FARO_ENVIRONMENT || process.env.NODE_ENV || 'production',
};

// --- served to the browser as window.FARO_CONFIG ---
app.get('/faro-config.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.FARO_CONFIG = ${JSON.stringify(FARO_CONFIG)};`);
});
```

Deployment env var (Kubernetes example):
```yaml
- name: FARO_COLLECTOR_URL
  value: https://alloy.sparks.majerus.dev/collect   # https when the app is behind TLS
```

---

## 4. `faro-init.js` — the browser bootstrap (complete, copy verbatim)

This initializes Faro with the default instrumentations **plus** tracing, then
wires rrweb session replay in the **exact** shape the plugin requires (§5).

```js
// Grafana Faro RUM bootstrap. Loaded in <head> before app scripts.
// Config injected by the server via /faro-config.js as window.FARO_CONFIG.
(function () {
  var cfg = window.FARO_CONFIG || {};
  if (!cfg.url) {
    console.warn('[faro] no collector URL configured — RUM disabled');
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
    instrumentations.push(new tracing.TracingInstrumentation()); // OTLP web traces
  }

  var faro = sdk.initializeFaro({
    url: cfg.url,
    app: {
      name: cfg.name || 'embers',          // MUST match the plugin's app_name
      version: cfg.version || '0.0.0',
      environment: cfg.environment || 'production',
    },
    instrumentations: instrumentations,
    // OPTIONAL but recommended for chatty apps: stop tracing your own internal
    // polling so it doesn't flood RUM with faro.tracing.fetch/resource noise.
    // ignoreUrls: [/\/api\//],
  });
  window.faro = faro;

  // OPTIONAL: identify the user (powers the Users page + attribution).
  // faro.api.setUser({ id: 'u-1072', username: 'tgarcia71', email: 't@example.io' });

  initSessionReplay(faro);

  // --- rrweb session replay (see §5 for the contract) ---
  function initSessionReplay(faro) {
    if (!window.rrweb || typeof window.rrweb.record !== 'function') {
      console.warn('[faro] rrweb not loaded — session replay disabled');
      return;
    }

    var buffer = [];
    var flushTimer = null;
    var MAX_BATCH = 50;        // flush after this many events…
    var FLUSH_INTERVAL = 5000; // …or at least this often (ms)

    // UTF-8 safe base64 (plain btoa throws on non-Latin1 DOM text).
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
    // collide across navigations).
    var seq = Date.now();

    function currentView() {
      try {
        var v = faro.api.getView && faro.api.getView();
        if (v && v.name) return v.name;
      } catch (e) {}
      return window.location.pathname || 'default';
    }

    function flush() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!buffer.length) return;
      var events = buffer;
      buffer = [];

      // THE CONTRACT (§5): a Faro LOG (kind=log) whose message is
      //   rrweb:<base64(JSON array of raw rrweb events)>
      // plus context { rrweb:'1', seq, view } → lands as
      //   context_rrweb / context_seq / context_view in Loki.
      // The plugin detects replay via context_rrweb='1'.
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
        if (buffer.length >= MAX_BATCH) flush();
        else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL);
      },
    });

    // Flush whatever is buffered when the user leaves.
    window.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  }
})();
```

---

## 5. rrweb replay — the exact wire contract (100% custom, get this right)

Stock Faro does not ship rrweb. Recording alone is **not enough**. Each chunk
must be a Faro **log** shaped **exactly** like this:

- **`message`** = `rrweb:<base64(JSON.stringify(rrwebEventsArray))>`
  - Raw rrweb events, **no field renaming** (keep `type`, `data`, `timestamp`).
  - UTF-8 → base64 (see `toBase64`); do not use bare `btoa` (breaks on Unicode).
- **`kind`** must be `log` → use `faro.api.pushLog([...])`, **not** `pushEvent`.
- **context** object `{ rrweb: '1', seq: '<n>', view: '<view name>' }` → lands in
  Loki as **`context_rrweb`**, **`context_seq`**, **`context_view`**.
  - **The plugin detects replay by `context_rrweb='1'`.** Without it, Replay and
    Heatmaps stay empty no matter how good the rrweb data is.
  - **`seq`** must be **globally increasing per session** — seed from `Date.now()`
    and increment. Per-page counters collide across navigations.
  - **`view`** = the current view name (path is fine).
- Start each page view's chunk stream with a **fresh rrweb meta + full snapshot**
  (rrweb's `record()` does this automatically on start; re-call `takeFullSnapshot`
  on SPA view changes if you have them).
- Keep chunks **well under ~1 MB** (Loki lines are capped at 4 MB; the receiver
  `max_allowed_payload_size` is 10 MiB). Batch at ~50 events / 5 s.

**Replay and Heatmaps both come from these chunks.** No chunks = no Replay tab,
no Heatmaps. Traces/logs can't substitute — they carry no DOM.

A correct line in Loki looks like:
```
kind=log message=rrweb:W3sidHlwZSI6NCwiZGF0YSI6...   context_rrweb=1 context_seq=1783633012496 context_view=/  session_id=duv7zHE4b1 app_name=embers ...
```
Decoding the base64 gives `[{"type":4,...},{"type":2,...(FullSnapshot)},{"type":3,...}]`.

---

## 6. What the plugin needs from every page (field reference)

### 6.1 Loki stream **labels** (hard requirements — nothing renders without these)
Stamped by the Alloy pipeline (§8), not the app, as long as you POST to `/collect`:

| Label | Value | Source |
|---|---|---|
| `job` | `faro` | static label in `loki.process` |
| `app_name` | your app slug | Faro `app.name` — **must match the plugin's picker** |
| `kind` | `log` \| `event` \| `measurement` \| `exception` | per Faro signal type |

### 6.2 Faro meta → logfmt **fields** (from SDK config, automatic)

| Field in Loki | From | Needed for |
|---|---|---|
| `session_id` | session instrumentation (on by default) | **everything** — non-negotiable |
| `app_version` | `app.version` | Versions page |
| `user_id`, `user_username`, `user_email` | `faro.api.setUser({id,username,email})` | Users page. Gotcha: `meta.user.username` → `user_username`, **not** `user_name` |
| `browser_*` | automatic | session summaries |
| `page_url` | automatic | top pages / per-page vitals |

### 6.3 Events & measurements per feature (free with default instrumentations)
- **Page views**: `event_name` = `faro.view.changed` **or** `faro.performance.navigation` (plugin matches either).
- **Sessions list**: `event_name=session_start` events. *(See §9 gotcha — a single long-lived tab barely emits these.)*
- **Errors page**: `kind=exception` with `type`, `value`, `stacktrace`.
- **Performance page**: `kind=measurement`, `type=web-vitals`, `value_lcp/cls/inp/fcp/ttfb/fid`.

Optional (pages degrade gracefully without them):
- `long_task`, `faro.performance.resource` → extra Performance panels.
- `frustration_rage_click` / `frustration_dead_click` / `frustration_error_click` (`event_data_selector`, `event_data_clicks`) → Frustration signals. **Not emitted by stock Faro** — you'd emit these yourself.
- `feature_flag_evaluated` (`event_data_flag`, `event_data_value`) → Flags page.

### 6.4 Traces (optional — Traces tab, per-event "View trace", app-logs pivot)
Requires `@grafana/faro-web-tracing` (already loaded):
- OTLP traces reach Tempo with **`resource.service.name` == the same `app_name`**.
- `session.id` attribute on the resource or spans.
- Events then carry `traceID`/`trace_id`, powering backend-log correlation.

---

## 7. Ingress / Service — exposing the collector (Kubernetes / Alloy Helm)

The `faro.receiver` listens on **:12347** at path **`/collect`**. Expose it through
the existing Alloy ingress (TLS-terminated) so the browser posts to
`https://<alloy-host>/collect`.

**Service (`extraPorts`) — add:**
```yaml
- name: "faro"
  port: 12347
  targetPort: 12347
  protocol: "TCP"
```

**Ingress (`extraPaths`) — add (raw k8s Ingress syntax; path is passed through, not rewritten):**
```yaml
- path: /collect
  pathType: Exact
  backend:
    service:
      name: alloy
      port:
        number: 12347
```
Your existing wildcard TLS secret already covers the host — no cert change. Set
`cors_allowed_origins` (§8) to your app origin once verified.

---

## 8. Alloy pipeline (add these two components to your Alloy config)

```hcl
// Receives browser RUM (logs + events + exceptions + rrweb chunks + OTLP traces).
faro.receiver "frontend" {
  server {
    listen_address           = "0.0.0.0"
    listen_port              = 12347
    cors_allowed_origins     = ["*"]    // tighten to your web origin(s) in prod
    max_allowed_payload_size = "10MiB"  // rrweb batches can be large
  }
  output {
    logs   = [loki.process.faro.receiver]        // → relabel → Loki
    traces = [otelcol.processor.batch.default.input] // → your existing Tempo path
  }
}

// Promote job/app_name/kind to STREAM LABELS (the plugin selects on these).
loki.process "faro" {
  stage.logfmt {
    mapping = { app_name = "", app_environment = "", kind = "" }
  }
  stage.static_labels {
    values = { job = "faro" }
  }
  stage.labels {
    values = { app_name = "", app_environment = "", kind = "" }
  }
  forward_to = [loki.write.default.receiver]   // your existing Loki writer (tenant header lives here)
}
```

Notes:
- `context_rrweb` / `context_seq` / `context_view` / `session_id` / `message` all
  pass through untouched — the receiver serializes the Faro log `context` into
  `context_<key>` fields automatically. **No extra Alloy config needed for §5.**
- `kind` **must** be a label — the plugin's replay/errors/perf selectors use
  `{... , kind="log"}` etc. This was the difference between "sessions list works
  but Replay is empty" and everything working.
- The Loki tenant (`X-Scope-OrgID`) is applied by your existing `loki.write`
  endpoint block, so browser code never sends it.
- Point the plugin's `rum-loki` datasource at the **same Loki** this writes to.

---

## 9. Gotchas we hit (save yourself the debugging)

1. **`pushEvent` vs `pushLog`.** Replay chunks must be `kind=log` via
   `pushLog`. Sending a `pushEvent('rrweb_replay', …)` produces `kind=event` and
   the plugin ignores it. (This alone cost hours.)
2. **`context_rrweb='1'` is the replay detector.** Correct message + labels +
   session_id but no `context` → Sessions list works, Replay/Heatmaps empty.
3. **`kind` must be a stream label**, not just a field. Add it to `loki.process`.
4. **`app_name` must exactly equal the plugin's picker value.** Mismatch = the
   app appears but every page is empty.
5. **Labels are set on ingest** — logs written *before* you add a label keep the
   old label set. Generate a fresh session after pipeline changes and query a
   time range that starts *after* the change.
6. **Sessions list looks empty on a long-lived tab.** The list is driven by
   `session_start` events, which Faro emits only when a *new* session begins.
   A single kept-open page reuses one session (activity resets the idle timer),
   so `session_start` is rare and ages out of short time windows. For a demo/load
   generator, rotate the Faro session periodically (`faro.api.resetSession()` /
   set a new session id) so `session_start` keeps flowing.
7. **Chatty apps flood RUM.** If your app polls its own API, `faro-web-tracing`
   emits a `faro.tracing.fetch` + `faro.performance.resource` per call. Use
   `ignoreUrls: [/\/api\//]` in `initializeFaro` to suppress that noise (it can
   bloat queries and tip the Sessions query into a 502).
8. **Unicode base64.** Use the `TextEncoder`-based `toBase64`; bare `btoa`
   throws on non-Latin1 DOM text.
9. **HTTPS mixed content.** If the page is HTTPS, the collector URL must be
   HTTPS too, or the browser silently blocks the POSTs.
10. **502/503 on one page but not others** = that specific plugin query is
    failing/timing out (often volume), not a data problem — verify Loki directly
    (§10) before assuming the instrumentation is broken.

---

## 10. Verification

### 10.1 Is the collector alive?
```bash
curl -i https://<alloy-host>/collect      # GET → 405 Method Not Allowed = receiver up
```
`405` = alive (POST-only). `404` = ingress path not matching. Connection refused = port not exposed.

### 10.2 Is data landing with the right labels? (curl)
```bash
curl -sG http://<loki-host>/loki/api/v1/query_range \
  -H 'X-Scope-OrgID: 1' \
  --data-urlencode 'query={job="faro", app_name="YOUR_APP"}' \
  --data-urlencode "start=$(( $(date +%s) - 3600 ))000000000" \
  --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode 'limit=5'
```

### 10.3 Are replay chunks correct? (this is the one that matters)
```logql
{job="faro", app_name="YOUR_APP", kind="log"} |~ "rrweb:" | logfmt | context_rrweb="1"
```
Expand a line and confirm:
- `context_rrweb=1`, `context_seq=<big number>`, `context_view=<view>`
- `session_id` matches a session shown in the plugin
- base64 in `message` decodes to an array containing a **`type:2` (FullSnapshot)**
  and **`type:4` (Meta)**, plus `type:3` incrementals

### 10.4 In the plugin
1. App appears in the picker within seconds of first traffic.
2. **Sessions** lists recent sessions (generate a fresh one — see §9.6).
3. Open a session → **Replay** tab plays; **Heatmaps** renders the DOM with click blobs.
4. If a page is empty, it's almost always a missing `session_id` or an `app_name` mismatch.

---

## 11. Minimal checklist

- [ ] `/faro-config.js` serves `window.FARO_CONFIG` from env (§3)
- [ ] `<head>` loads config → faro-web-sdk → faro-web-tracing → rrweb → faro-init, in order (§2)
- [ ] `initializeFaro` with `app.name` == plugin picker value + `getWebInstrumentations()` + `TracingInstrumentation` (§4)
- [ ] rrweb chunks via `pushLog(['rrweb:'+base64], { level:'info', context:{rrweb:'1', seq, view} })` (§5)
- [ ] Alloy `faro.receiver` (:12347 `/collect`) → `loki.process "faro"` stamping `job`/`app_name`/`kind` labels (§8)
- [ ] Service `extraPorts` 12347 + ingress `/collect` route (§7)
- [ ] `rum-loki` datasource points at the Loki the pipeline writes to
- [ ] Verified `context_rrweb="1"` chunks with a FullSnapshot in Loki (§10.3)
- [ ] (Recommended) session rotation + `ignoreUrls` for chatty apps (§9.6–9.7)
```
