/**
 * P2-23 外部追踪基座（2026-11-13）
 *
 * 基于 OpenTelemetry JS SDK 接入，安装方式：
 *   npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
 *   npm install @opentelemetry/exporter-otlp-grpc
 *
 * 环境变量：
 *   OTEL_ENABLED=1              — 开启追踪（默认关闭，零额外开销
 *   OTEL_SERVICE_NAME=platform  — 服务名
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP 接收端点（如 http://localhost:4317）
 *   OTEL_EXPORTER_OTLP_HEADERS  — 额外头（如 x-api-key=xxx）
 *
 * 用法（在 server.js 顶部引入）：
 *   require('./src-server/lib/opentelemetry');
 */
const OTelEnabled = process.env.OTEL_ENABLED === '1';

if (OTelEnabled) {
  try {
    const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-otlp-grpc');

    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || '智能体开发平台',
      traceExporter: new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317',
      }),
      instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-fs': { enabled: false }, // 文件操作追踪噪音大，默认关闭
      })],
    });

    sdk.start();
    console.log('[otel] OpenTelemetry SDK 已启动（导出端点：' + (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317') + '）');

    // 优雅关闭（进程退出前刷新导出缓存
    process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
    process.on('SIGINT', () => sdk.shutdown().catch(() => {}));
  } catch (e) {
    console.warn('[otel] OpenTelemetry SDK 启动失败（依赖可能未安装）：', e.message);
  }
} else {
  module.exports = {}; // OTEL 未启用，空导出
}