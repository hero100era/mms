import * as crypto from 'node:crypto'

export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO'

export type AlertType =
  | 'RECONCILIATION_DISCREPANCY'
  | 'SEAL_LAG_EXCEEDED'
  | 'FORWARDER_LAG_EXCEEDED'
  | 'FORWARDER_DELIVERY_FAILURE'
  | 'WORM_COLLISION_OR_CORRUPTION'
  | 'SEAL_TAMPER_DETECTED'
  | 'RETENTION_PURGE_EXECUTED'
  | 'CRYPTO_SHRED_EXECUTED'
  | 'MALWARE_DETECTED'
  | 'MALWARE_SCANNER_FAILURE'
  | 'ZERO_RECORD_ANOMALY'
  | 'BREAK_GLASS_ACTIVATED'
  | 'BREAK_GLASS_DRILL_OVERDUE'

export interface SecurityAlert {
  id: string
  timestamp: string
  type: AlertType
  severity: AlertSeverity
  source: string
  message: string
  details?: Record<string, unknown>
}

export interface AlertSink {
  emit(alert: SecurityAlert): Promise<void>
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: SecurityAlert[] = []

  async emit(alert: SecurityAlert): Promise<void> {
    this.alerts.push(alert)
  }

  clear(): void {
    this.alerts.length = 0
  }

  findByType(type: AlertType): SecurityAlert[] {
    return this.alerts.filter((a) => a.type === type)
  }

  findBySeverity(severity: AlertSeverity): SecurityAlert[] {
    return this.alerts.filter((a) => a.severity === severity)
  }
}

export class ConsoleAlertSink implements AlertSink {
  async emit(alert: SecurityAlert): Promise<void> {
    let prefix = `[SECURITY ALERT] [${alert.severity}] [${alert.type}]`
    if (alert.severity === 'CRITICAL') {
      console.error(`${prefix} ${alert.message}`, alert.details ?? '')
    } else if (alert.severity === 'WARNING') {
      console.warn(`${prefix} ${alert.message}`, alert.details ?? '')
    } else {
      console.info(`${prefix} ${alert.message}`, alert.details ?? '')
    }
  }
}

/**
 * R8.5: OutboxAlertSink writes security-critical alerts directly into core.outbox
 * within a transaction or pool query, ensuring durable delivery, lease timeouts,
 * exponential retries, and dead-letter queue escalation.
 */
export class OutboxAlertSink implements AlertSink {
  private pool: { query: (sql: string, params: unknown[]) => Promise<unknown> }

  constructor(pool: { query: (sql: string, params: unknown[]) => Promise<unknown> }) {
    this.pool = pool
  }

  async emit(alert: SecurityAlert): Promise<void> {
    await this.pool.query(
      'select private.enqueue_security_alert($1, $2, $3, $4, $5)',
      [alert.type, alert.severity, alert.source, alert.message, JSON.stringify(alert.details ?? {})],
    )
  }
}

const MAX_ALERT_HISTORY = 500

export class Alerter {
  private sinks: AlertSink[]
  private history: SecurityAlert[] = []

  private recordHistory(alert: SecurityAlert): void {
    this.history.push(alert)
    if (this.history.length > MAX_ALERT_HISTORY) {
      this.history.splice(0, this.history.length - MAX_ALERT_HISTORY)
    }
  }

  constructor(sinks: AlertSink[] = [new ConsoleAlertSink()]) {
    this.sinks = sinks
  }

  addSink(sink: AlertSink): void {
    this.sinks.push(sink)
  }

  async emit(
    type: AlertType,
    severity: AlertSeverity,
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<SecurityAlert> {
    let alert: SecurityAlert = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      severity,
      source,
      message,
      details,
    }
    this.recordHistory(alert)
    for (let sink of this.sinks) {
      try {
        await sink.emit(alert)
      } catch (err) {
        console.error(`Alert sink error delivering alert ${alert.id}:`, err)
      }
    }
    return alert
  }

  /**
   * R8.5: Direct emission without re-enqueuing into OutboxAlertSink,
   * used when the outbox poller dispatches durable alerts to notify external channels.
   * Throws on transport error so outbox poller can trigger durable retries.
   */
  async emitDirect(
    type: AlertType,
    severity: AlertSeverity,
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<SecurityAlert> {
    let alert: SecurityAlert = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      severity,
      source,
      message,
      details,
    }
    this.recordHistory(alert)
    for (let sink of this.sinks) {
      if (sink instanceof OutboxAlertSink) continue
      try {
        await sink.emit(alert)
      } catch (err) {
        console.error(`Alert sink error in direct delivery ${alert.id}:`, err)
        throw err
      }
    }
    return alert
  }

  getHistory(): readonly SecurityAlert[] {
    return this.history
  }

  clear(): void {
    this.history = []
  }
}

export const defaultAlerter = new Alerter()

/**
 * Helper to transactionally enqueue a security alert into core.outbox.
 */
export async function enqueueSecurityAlert(
  pool: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  type: AlertType,
  severity: AlertSeverity,
  source: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<string> {
  let res = (await pool.query(
    'select private.enqueue_security_alert($1, $2, $3, $4, $5) as job_id',
    [type, severity, source, message, JSON.stringify(details ?? {})],
  )) as { rows: { job_id: string }[] }
  return res.rows[0]?.job_id ?? ''
}
