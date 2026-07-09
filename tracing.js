const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');

// Enable OpenTelemetry diagnostics (optional, for debugging)
// Change to INFO or WARN to reduce verbosity, or remove entirely
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

// Get configuration from environment
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

// Configure OpenTelemetry trace exporter
const otlpExporter = new OTLPTraceExporter({
  url: `${OTEL_ENDPOINT}/v1/traces`,
  headers: {},
});

// Configure OpenTelemetry SDK - using traceExporter (not spanProcessor)
// This will automatically create a BatchSpanProcessor for the OTLP exporter
const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'embers',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter: otlpExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

// Start the SDK
sdk.start();

console.log(`🔭 OpenTelemetry SDK started`);
console.log(`🔭 OTEL endpoint: ${OTEL_ENDPOINT}`);

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => {
      console.log('OpenTelemetry SDK shut down successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error shutting down OpenTelemetry SDK', error);
      process.exit(1);
    });
});
