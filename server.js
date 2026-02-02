const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
const express = require('express');
const path = require('path');
const promClient = require('prom-client');
const winston = require('winston');

// Enable OpenTelemetry diagnostics (optional, for debugging)
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

// Get configuration from environment
const PORT = process.env.PORT || 3000;
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

// Create Winston logger for structured logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ],
});

// Configure OpenTelemetry SDK
// Using environment variables: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_SERVICE_NAME
const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'embers',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start()
  .then(() => {
    logger.info('OpenTelemetry SDK started', {
      endpoint: OTEL_ENDPOINT,
      service: 'embers',
      timestamp: new Date().toISOString()
    });
  })
  .catch((error) => {
    logger.error('Failed to start OpenTelemetry SDK', {
      error: error.message,
      stack: error.stack,
      endpoint: OTEL_ENDPOINT
    });
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
app.use(express.static('public'));

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
    otelEndpoint: OTEL_ENDPOINT,
  });
});

// Start server
app.listen(PORT, () => {
  logger.info('Embers server started', {
    port: PORT,
    otel_endpoint: OTEL_ENDPOINT,
    timestamp: new Date().toISOString(),
  });
  console.log(`🔥 Embers running on http://localhost:${PORT}`);
  console.log(`📊 Metrics available at http://localhost:${PORT}/metrics`);
  console.log(`🔭 OTEL endpoint: ${OTEL_ENDPOINT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  sdk.shutdown()
    .then(() => {
      logger.info('OpenTelemetry SDK shut down successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Error shutting down OpenTelemetry SDK', { error: error.message });
      process.exit(1);
    });
});
