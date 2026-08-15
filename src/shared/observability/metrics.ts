/**
 * A deliberately small metrics registry: counters, gauges and histograms in Prometheus
 * exposition format.
 *
 * Why not prom-client: the dependency is fine, but the metrics that matter here are a
 * dozen domain counters, and hand-rolling them keeps the naming/label discipline visible in
 * one file and adds no runtime weight to a 0.5 vCPU task. If we later need exemplars,
 * pushgateway or native histograms, prom-client becomes worth it.
 *
 * The counters chosen are the ones that answer operational questions:
 *   booking_conflict_total rising sharply means either a hot slot or a broken client;
 *   idempotency_replay_total rising means clients are retrying, i.e. something upstream is
 *   timing out; db_pool_waiting > 0 means we are about to start queueing requests.
 */

type Labels = Record<string, string>;

const serialiseLabels = (labels: Labels): string => {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return '';
  const body = entries
    .map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, '_')}"`)
    .join(',');
  return `{${body}}`;
};

interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
}

export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<
    string,
    Map<string, { buckets: number[]; sum: number; count: number }>
  >();
  private readonly gaugeProviders = new Map<string, () => number>();

  // Latency buckets in seconds, chosen around our SLO rather than the library default:
  // the interesting region for a booking API is 10ms-1s.
  private readonly bucketBounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

  registerCounter(name: string, help: string): void {
    this.definitions.set(name, { name, help, type: 'counter' });
    if (!this.counters.has(name)) this.counters.set(name, new Map());
  }

  registerGauge(name: string, help: string): void {
    this.definitions.set(name, { name, help, type: 'gauge' });
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
  }

  registerHistogram(name: string, help: string): void {
    this.definitions.set(name, { name, help, type: 'histogram' });
    if (!this.histograms.has(name)) this.histograms.set(name, new Map());
  }

  /** Registers a gauge whose value is read at scrape time (pool depth, queue lag, ...). */
  registerGaugeProvider(name: string, help: string, provider: () => number): void {
    this.registerGauge(name, help);
    this.gaugeProviders.set(name, provider);
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name);
    if (!series) return;
    const key = serialiseLabels(labels);
    series.set(key, (series.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    const series = this.gauges.get(name);
    if (!series) return;
    series.set(serialiseLabels(labels), value);
  }

  observe(name: string, seconds: number, labels: Labels = {}): void {
    const series = this.histograms.get(name);
    if (!series) return;

    const key = serialiseLabels(labels);
    let entry = series.get(key);
    if (!entry) {
      entry = { buckets: new Array<number>(this.bucketBounds.length).fill(0), sum: 0, count: 0 };
      series.set(key, entry);
    }

    entry.sum += seconds;
    entry.count += 1;
    for (let index = 0; index < this.bucketBounds.length; index += 1) {
      const bound = this.bucketBounds[index];
      if (bound !== undefined && seconds <= bound) {
        entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
      }
    }
  }

  render(): string {
    const lines: string[] = [];

    for (const definition of this.definitions.values()) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);

      if (definition.type === 'counter') {
        const series = this.counters.get(definition.name);
        if (series && series.size > 0) {
          for (const [labels, value] of series) {
            lines.push(`${definition.name}${labels} ${value}`);
          }
        } else {
          // Emit a zero sample so dashboards and alerts have a series to attach to before
          // the first event ever occurs.
          lines.push(`${definition.name} 0`);
        }
        continue;
      }

      if (definition.type === 'gauge') {
        const provider = this.gaugeProviders.get(definition.name);
        if (provider) {
          lines.push(`${definition.name} ${provider()}`);
          continue;
        }
        const series = this.gauges.get(definition.name);
        for (const [labels, value] of series ?? []) {
          lines.push(`${definition.name}${labels} ${value}`);
        }
        continue;
      }

      const series = this.histograms.get(definition.name);
      for (const [labels, entry] of series ?? []) {
        const inner = labels.length > 0 ? labels.slice(1, -1) : '';
        // `observe` already increments every bucket whose bound the value falls under, so
        // the stored counts are cumulative as Prometheus requires.
        for (let index = 0; index < this.bucketBounds.length; index += 1) {
          const bound = this.bucketBounds[index];
          const labelSet = inner.length > 0 ? `${inner},le="${bound}"` : `le="${bound}"`;
          lines.push(`${definition.name}_bucket{${labelSet}} ${entry.buckets[index] ?? 0}`);
        }
        const infLabels = inner.length > 0 ? `${inner},le="+Inf"` : 'le="+Inf"';
        lines.push(`${definition.name}_bucket{${infLabels}} ${entry.count}`);
        lines.push(`${definition.name}_sum${labels} ${entry.sum}`);
        lines.push(`${definition.name}_count${labels} ${entry.count}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }
}

/** Metric names, centralised so a dashboard query and the emitting code cannot drift. */
export const Metric = {
  HTTP_REQUESTS: 'careflow_http_requests_total',
  HTTP_DURATION: 'careflow_http_request_duration_seconds',
  LOGIN_ATTEMPTS: 'careflow_login_attempts_total',
  HOLD_CREATED: 'careflow_hold_created_total',
  HOLD_REJECTED: 'careflow_hold_rejected_total',
  HOLD_EXPIRED: 'careflow_hold_expired_total',
  BOOKING_CONFIRMED: 'careflow_booking_confirmed_total',
  BOOKING_CONFLICT: 'careflow_booking_conflict_total',
  RECURRING_CONFIRMED: 'careflow_recurring_series_confirmed_total',
  RECURRING_CONFLICT: 'careflow_recurring_conflict_total',
  APPOINTMENT_CANCELLED: 'careflow_appointment_cancelled_total',
  STATUS_CHANGED: 'careflow_appointment_status_changed_total',
  IDEMPOTENCY_REPLAY: 'careflow_idempotency_replay_total',
  IDEMPOTENCY_CONFLICT: 'careflow_idempotency_conflict_total',
  OUTBOX_PUBLISHED: 'careflow_outbox_published_total',
  OUTBOX_FAILED: 'careflow_outbox_failed_total',
  OUTBOX_DEAD: 'careflow_outbox_dead_total',
  OUTBOX_PENDING: 'careflow_outbox_pending',
  CONSUMER_PROCESSED: 'careflow_consumer_processed_total',
  CONSUMER_DUPLICATE: 'careflow_consumer_duplicate_total',
  DB_POOL_TOTAL: 'careflow_db_pool_total',
  DB_POOL_IDLE: 'careflow_db_pool_idle',
  DB_POOL_WAITING: 'careflow_db_pool_waiting',
  DB_POOL_MAX: 'careflow_db_pool_max',
  CACHE_HEALTHY: 'careflow_cache_healthy',
} as const;

export const createMetricsRegistry = (): MetricsRegistry => {
  const registry = new MetricsRegistry();

  registry.registerCounter(
    Metric.HTTP_REQUESTS,
    'HTTP requests by route, method and status class.',
  );
  registry.registerHistogram(Metric.HTTP_DURATION, 'HTTP request duration in seconds.');
  registry.registerCounter(Metric.LOGIN_ATTEMPTS, 'Login attempts by outcome.');
  registry.registerCounter(Metric.HOLD_CREATED, 'Slot holds created.');
  registry.registerCounter(Metric.HOLD_REJECTED, 'Hold attempts rejected, by reason.');
  registry.registerCounter(Metric.HOLD_EXPIRED, 'Holds expired by the sweeper.');
  registry.registerCounter(Metric.BOOKING_CONFIRMED, 'One-time appointments confirmed.');
  registry.registerCounter(
    Metric.BOOKING_CONFLICT,
    'Booking attempts that lost a race for a slot.',
  );
  registry.registerCounter(Metric.RECURRING_CONFIRMED, 'Recurring series confirmed.');
  registry.registerCounter(Metric.RECURRING_CONFLICT, 'Recurring series rejected for conflicts.');
  registry.registerCounter(Metric.APPOINTMENT_CANCELLED, 'Cancellations by scope.');
  registry.registerCounter(Metric.STATUS_CHANGED, 'Appointment status transitions.');
  registry.registerCounter(Metric.IDEMPOTENCY_REPLAY, 'Requests answered from a stored response.');
  registry.registerCounter(
    Metric.IDEMPOTENCY_CONFLICT,
    'Idempotency keys reused with a different body.',
  );
  registry.registerCounter(Metric.OUTBOX_PUBLISHED, 'Outbox events published to the queue.');
  registry.registerCounter(Metric.OUTBOX_FAILED, 'Outbox publish attempts that failed.');
  registry.registerCounter(Metric.OUTBOX_DEAD, 'Outbox events abandoned after exhausting retries.');
  registry.registerCounter(Metric.CONSUMER_PROCESSED, 'Queue messages processed.');
  registry.registerCounter(
    Metric.CONSUMER_DUPLICATE,
    'Queue messages skipped as already processed.',
  );

  return registry;
};
