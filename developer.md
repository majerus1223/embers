# developer.md — Instrument your app for the RUM plugin (quick version)

Goal: get your app into `majerus-rum-app` (Sessions, Errors, Perf, **Replay**, **Heatmaps**).
Full detail in [Implement.md](Implement.md). This is the short path.

## 1. Load in `<head>` (before app code, in this order)
```html
<script src="/faro-config.js"></script>
<script src="https://unpkg.com/@grafana/faro-web-sdk@2.8.2/dist/bundle/faro-web-sdk.iife.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@grafana/faro-web-tracing@2.8.2/dist/bundle/faro-web-tracing.iife.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/rrweb@2.1.0/dist/rrweb.umd.min.cjs" crossorigin="anonymous"></script>
<script src="/faro-init.js"></script>
```

## 2. Server: inject config (don't hardcode the URL)
```js
app.get('/faro-config.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store').send(
    `window.FARO_CONFIG = ${JSON.stringify({
      url: process.env.FARO_COLLECTOR_URL || 'https://alloy.sparks.majerus.dev/collect',
      name: 'YOUR_APP',                 // must match the plugin's app picker
      version: require('./package.json').version,
      environment: process.env.NODE_ENV || 'production',
    })};`);
});
```

## 3. `faro-init.js`
```js
(function () {
  var cfg = window.FARO_CONFIG || {};
  var sdk = window.GrafanaFaroWebSdk, tracing = window.GrafanaFaroWebTracing;
  if (!cfg.url || !sdk) return;

  var instr = sdk.getWebInstrumentations();               // errors, web-vitals, console, views
  if (tracing) instr.push(new tracing.TracingInstrumentation());

  var faro = sdk.initializeFaro({
    url: cfg.url,
    app: { name: cfg.name, version: cfg.version, environment: cfg.environment },
    instrumentations: instr,
    // ignoreUrls: [/\/api\//],   // recommended if your app polls its own API
  });
  window.faro = faro;

  // rrweb session replay — EXACT contract the plugin needs.
  if (window.rrweb) {
    var buf = [], t = null, seq = Date.now();
    function b64(s){var b=new TextEncoder().encode(s),o='';for(var i=0;i<b.length;i+=0x8000)o+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(o);}
    function view(){try{var v=faro.api.getView&&faro.api.getView();if(v&&v.name)return v.name;}catch(e){}return location.pathname||'default';}
    function flush(){ if(t){clearTimeout(t);t=null;} if(!buf.length)return; var e=buf; buf=[];
      faro.api.pushLog(['rrweb:'+b64(JSON.stringify(e))], { level:'info',
        context:{ rrweb:'1', seq:String(seq++), view:view() } }); }
    window.rrweb.record({ emit:function(ev){ buf.push(ev);
      if(buf.length>=50) flush(); else if(!t) t=setTimeout(flush,5000); } });
    addEventListener('visibilitychange',function(){ if(document.visibilityState==='hidden') flush(); });
    addEventListener('pagehide', flush);
  }
})();
```

## 4. The non-negotiables (why it works)
- Replay chunks are Faro **logs**: `pushLog(['rrweb:'+base64(events)], { context:{ rrweb:'1', seq, view } })`.
  The plugin detects replay by **`context_rrweb='1'`** — no context, no Replay/Heatmaps.
- `seq` seeded from `Date.now()` (globally increasing across navigations).
- `app.name` must **exactly** match the plugin's app picker.
- `session_id` (automatic) is required for everything.

## 5. Deploy env var
```yaml
- name: FARO_COLLECTOR_URL
  value: https://alloy.sparks.majerus.dev/collect
```
(Alloy `faro.receiver` + `loki.process` labels are infra-side — see [Implement.md](Implement.md) §7–§8. You don't touch those.)

## 6. Verify
```
{job="faro", app_name="YOUR_APP", kind="log"} |~ "rrweb:" | logfmt | context_rrweb="1"
```
A line with `context_rrweb=1` whose base64 decodes to include a `type:2` (FullSnapshot) = done.
App appears in the picker within seconds. Empty pages → check `app_name` match / `session_id`.
