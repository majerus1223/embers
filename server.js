// IMPORTANT: Initialize OpenTelemetry BEFORE requiring any other modules
require('./tracing');

const express = require('express');
const path = require('path');
const promClient = require('prom-client');
const winston = require('winston');
const { trace, context } = require('@opentelemetry/api');

// Get configuration from environment
const PORT = process.env.PORT || 3000;

// Grafana Faro (browser RUM) runtime config. The collector URL is NOT
// hardcoded in client code — it's supplied by the deployment env so it can
// differ per environment / TLS setup. Falls back to the known Alloy
// faro.receiver endpoint if unset.
const APP_VERSION = process.env.APP_VERSION || require('./package.json').version;
const FARO_CONFIG = {
  // Faro collector, fronted by the Alloy ingress (TLS-terminated) and routed
  // to the faro.receiver on alloy:12347.
  url: process.env.FARO_COLLECTOR_URL || process.env.FARO_URL || 'https://alloy.sparks.majerus.dev/collect',
  // Must be exactly 'embers' — the RUM backend filters everything by app_name.
  name: 'embers',
  version: APP_VERSION,
  environment: process.env.FARO_ENVIRONMENT || process.env.NODE_ENV || 'production',
};

// Custom Winston format to inject OpenTelemetry trace context
const traceFormat = winston.format((info) => {
  const span = trace.getSpan(context.active());
  if (span) {
    const spanContext = span.spanContext();
    info.trace_id = spanContext.traceId;
    info.span_id = spanContext.spanId;
    info.trace_flags = spanContext.traceFlags;
  }
  return info;
});

// Create Winston logger for structured logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    traceFormat(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ],
});

// Setup Prometheus metrics for scraping
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const flameCounter = new promClient.Gauge({
  name: 'embers_flame_count',
  help: 'Current number of flames',
  registers: [register],
});

const renderDuration = new promClient.Histogram({
  name: 'embers_render_duration_ms',
  help: 'Flame render duration in milliseconds',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

const buttonClicks = new promClient.Counter({
  name: 'embers_button_clicks_total',
  help: 'Total number of button clicks',
  labelNames: ['button_type'],
  registers: [register],
});

const uptimeGauge = new promClient.Gauge({
  name: 'embers_uptime_seconds',
  help: 'Application uptime in seconds',
  registers: [register],
});

const randomMetric1 = new promClient.Gauge({
  name: 'embers_temperature_celsius',
  help: 'Simulated flame temperature',
  registers: [register],
});

const randomMetric2 = new promClient.Counter({
  name: 'embers_sparks_emitted_total',
  help: 'Total sparks emitted from flames',
  registers: [register],
});

// Track uptime
const startTime = Date.now();
setInterval(() => {
  uptimeGauge.set((Date.now() - startTime) / 1000);
}, 1000);

// Create Express app
const app = express();
app.use(express.json());

// Expose the Faro config to the browser as `window.FARO_CONFIG`. Served
// dynamically so the collector URL comes from the deployment env at runtime
// (no rebuild needed), rather than being baked into the static assets.
app.get('/faro-config.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.FARO_CONFIG = ${JSON.stringify(FARO_CONFIG)};`);
});

app.use(express.static('public'));

// Flame design picker page (a real second route so RUM journeys have steps).
app.get('/designs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'designs.html'));
});

// API endpoint to update flame count
app.post('/api/flames', (req, res) => {
  const { count, action } = req.body;

  // Update metrics
  flameCounter.set(count);
  if (action) {
    buttonClicks.inc({ button_type: action });
  }

  // Generate logs
  logger.info('Flame count updated', {
    flame_count: count,
    action: action,
    timestamp: new Date().toISOString(),
    user_action: true,
  });

  // Simulate random metrics
  randomMetric1.set(800 + Math.random() * 400); // 800-1200 celsius
  randomMetric2.inc(Math.floor(Math.random() * 10) + count);

  res.json({ success: true, count });
});

// API endpoint to record render performance
app.post('/api/render', (req, res) => {
  const { duration, flameCount } = req.body;

  renderDuration.observe(duration);

  // Generate logs proportional to flame count
  const logCount = Math.ceil(flameCount / 5); // 1 log per 5 flames
  for (let i = 0; i < logCount; i++) {
    const level = Math.random() > 0.8 ? 'warn' : 'info';
    logger.log(level, 'Flame rendered', {
      flame_index: i,
      duration_ms: duration,
      total_flames: flameCount,
      timestamp: new Date().toISOString(),
      render_cycle: Math.floor(Date.now() / 1000),
    });
  }

  res.json({ success: true });
});

// API endpoint to generate random logs
app.post('/api/logs', (req, res) => {
  const { flameCount } = req.body;

  // Generate random logs
  const logTypes = ['info', 'warn', 'error'];
  const messages = [
    'Flame particle physics calculated',
    'Heat dissipation computed',
    'Oxygen consumption measured',
    'Ember glow intensity adjusted',
    'Flame color spectrum updated',
    'Combustion reaction simulated',
    'Thermal dynamics processed',
    'Flame turbulence calculated',
  ];

  const numLogs = Math.ceil(flameCount / 3);
  for (let i = 0; i < numLogs; i++) {
    const level = logTypes[Math.floor(Math.random() * logTypes.length)];
    const message = messages[Math.floor(Math.random() * messages.length)];
    logger.log(level, message, {
      flame_count: flameCount,
      random_value: Math.random() * 100,
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: true, logsGenerated: numLogs });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Health check
app.get('/health', (req, res) => {
  logger.info('Health check performed');
  res.json({
    status: 'healthy',
    uptime: (Date.now() - startTime) / 1000,
  });
});

// Start server
app.listen(PORT, () => {
  logger.info('Embers server started', {
    port: PORT,
    timestamp: new Date().toISOString(),
  });
  console.log(`🔥 Embers running on http://localhost:${PORT}`);
  console.log(`📊 Metrics available at http://localhost:${PORT}/metrics`);
  console.log(`👁️  Faro RUM collector: ${FARO_CONFIG.url} (app=${FARO_CONFIG.name}@${FARO_CONFIG.version}, env=${FARO_CONFIG.environment})`);
});
