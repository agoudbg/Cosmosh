import { randomBytes } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import {
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_DEFAULT_RETENTION_DAYS,
  AUDIT_DEFAULT_SCOPE_ACCOUNT_ID,
  AUDIT_DEFAULT_SCOPE_DEVICE_ID,
  AUDIT_MAX_METADATA_BYTES,
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_RETENTION_SWEEP_INTERVAL_MS,
} from './constants.js';
import { parseAuditMetadata, sanitizeAuditMetadata } from './sanitizer.js';
import type {
  AuditEventDetail,
  AuditEventInput,
  AuditEventListQuery,
  AuditEventListResult,
  AuditEventOutcome,
  AuditEventSeverity,
} from './types.js';

type GetDbClient = () => PrismaClient;

type AuditEventServiceOptions = {
  getDbClient: GetDbClient;
  defaultScopeAccountId?: string;
  defaultScopeDeviceId?: string;
  retentionDays?: number;
  maxMetadataBytes?: number;
  defaultPageSize?: number;
  maxPageSize?: number;
};

/**
 * Creates a lexicographically sortable event id with timestamp prefix.
 *
 * @param occurredAt Event timestamp.
 * @returns Time-ordered event id.
 */
const createOrderedEventId = (occurredAt: Date): string => {
  const timestampSegment = occurredAt.getTime().toString(36).padStart(10, '0');
  const randomSegment = randomBytes(6).toString('hex');
  return `${timestampSegment}_${randomSegment}`;
};

/**
 * Parses and normalizes list pagination values.
 *
 * @param page Requested page.
 * @param pageSize Requested page size.
 * @param defaultPageSize Default page size.
 * @param maxPageSize Maximum accepted page size.
 * @returns Normalized pagination values.
 */
const normalizePagination = (
  page: number | undefined,
  pageSize: number | undefined,
  defaultPageSize: number,
  maxPageSize: number,
): { page: number; pageSize: number } => {
  const normalizedPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page ?? 1)) : 1;
  const normalizedPageSize = Number.isFinite(pageSize)
    ? Math.max(1, Math.min(maxPageSize, Math.trunc(pageSize ?? defaultPageSize)))
    : defaultPageSize;

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
};

/**
 * Local-first audit event service.
 *
 * The service guarantees write calls are non-blocking from caller perspective:
 * write errors are swallowed and only logged to stderr.
 */
export class AuditEventService {
  private readonly getDbClient: GetDbClient;

  private readonly defaultScopeAccountId: string;

  private readonly defaultScopeDeviceId: string;

  private readonly retentionDays: number;

  private readonly maxMetadataBytes: number;

  private readonly defaultPageSize: number;

  private readonly maxPageSize: number;

  private lastRetentionSweepAtMs = 0;

  constructor(options: AuditEventServiceOptions) {
    this.getDbClient = options.getDbClient;
    this.defaultScopeAccountId = options.defaultScopeAccountId ?? AUDIT_DEFAULT_SCOPE_ACCOUNT_ID;
    this.defaultScopeDeviceId = options.defaultScopeDeviceId ?? AUDIT_DEFAULT_SCOPE_DEVICE_ID;
    this.retentionDays = options.retentionDays ?? AUDIT_DEFAULT_RETENTION_DAYS;
    this.maxMetadataBytes = options.maxMetadataBytes ?? AUDIT_MAX_METADATA_BYTES;
    this.defaultPageSize = options.defaultPageSize ?? AUDIT_DEFAULT_PAGE_SIZE;
    this.maxPageSize = options.maxPageSize ?? AUDIT_MAX_PAGE_SIZE;
  }

  /**
   * Writes one audit event record and swallows all storage errors.
   *
   * @param input Audit event payload.
   * @returns Event id on success, otherwise null.
   */
  public async logEvent(input: AuditEventInput): Promise<string | null> {
    try {
      return await this.persistEvent(input);
    } catch (error: unknown) {
      console.error('[audit] Failed to persist audit event.', error);
      return null;
    }
  }

  /**
   * Writes one audit event and propagates storage errors to fail-closed callers.
   *
   * @param input Audit event payload.
   * @returns Persisted event id.
   */
  public async logRequiredEvent(input: AuditEventInput): Promise<string> {
    return await this.persistEvent(input);
  }

  /**
   * Lists audit events with pagination and optional multidimensional filters.
   *
   * @param query Query filters and paging options.
   * @returns Paginated audit event list.
   */
  public async listEvents(query: AuditEventListQuery): Promise<AuditEventListResult> {
    const { page, pageSize } = normalizePagination(query.page, query.pageSize, this.defaultPageSize, this.maxPageSize);

    const now = new Date();
    const defaultStartAt = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
    const occurredAtFilter: Prisma.DateTimeFilter = {};
    occurredAtFilter.gte = query.startAt ?? defaultStartAt;

    if (query.endAt) {
      occurredAtFilter.lte = query.endAt;
    }

    const keyword = query.keyword?.trim();
    const where: Prisma.AuditEventWhereInput = {
      occurredAt: occurredAtFilter,
      ...(query.category ? { category: query.category } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(keyword
        ? {
            OR: [
              { category: { contains: keyword } },
              { action: { contains: keyword } },
              { outcome: { contains: keyword } },
              { severity: { contains: keyword } },
              { entityType: { contains: keyword } },
              { entityId: { contains: keyword } },
              { sessionId: { contains: keyword } },
              { requestId: { contains: keyword } },
              { correlationId: { contains: keyword } },
              { relatedRecordId: { contains: keyword } },
              { metadataJson: { contains: keyword } },
            ],
          }
        : {}),
    };

    const db = this.getDbClient();
    const [total, rows] = await Promise.all([
      db.auditEvent.count({ where }),
      db.auditEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => ({
        eventId: row.eventId,
        occurredAt: row.occurredAt.toISOString(),
        category: row.category,
        action: row.action,
        outcome: row.outcome as AuditEventOutcome,
        severity: row.severity as AuditEventSeverity,
        scopeAccountId: row.scopeAccountId,
        scopeDeviceId: row.scopeDeviceId,
        entityType: row.entityType ?? undefined,
        entityId: row.entityId ?? undefined,
        sessionId: row.sessionId ?? undefined,
        requestId: row.requestId ?? undefined,
        correlationId: row.correlationId ?? undefined,
        relatedRecordId: row.relatedRecordId ?? undefined,
      })),
      pagination: {
        page,
        pageSize,
        total,
        hasMore: page * pageSize < total,
      },
    };
  }

  /**
   * Persists one sanitized audit event without applying an error policy.
   *
   * @param input Audit event payload.
   * @returns Persisted event id.
   */
  private async persistEvent(input: AuditEventInput): Promise<string> {
    const occurredAt = input.occurredAt ?? new Date();
    const eventId = createOrderedEventId(occurredAt);
    const retentionUntilAt = new Date(occurredAt.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
    const metadata = sanitizeAuditMetadata(input.metadata, this.maxMetadataBytes);

    const db = this.getDbClient();
    await db.auditEvent.create({
      data: {
        eventId,
        occurredAt,
        category: input.category,
        action: input.action,
        outcome: input.outcome,
        severity: input.severity,
        scopeAccountId: input.scopeAccountId ?? this.defaultScopeAccountId,
        scopeDeviceId: input.scopeDeviceId ?? this.defaultScopeDeviceId,
        entityType: input.entityType,
        entityId: input.entityId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        correlationId: input.correlationId,
        metadataJson: metadata.metadataJson,
        relatedRecordId: input.relatedRecordId,
        retentionUntilAt,
      },
    });

    void this.maybeSweepExpiredEvents();
    return eventId;
  }

  /**
   * Returns one audit event detail by event id.
   *
   * @param eventId Event id.
   * @returns Audit event detail when found, otherwise null.
   */
  public async getEventById(eventId: string): Promise<AuditEventDetail | null> {
    const db = this.getDbClient();
    const row = await db.auditEvent.findUnique({
      where: {
        eventId,
      },
    });

    if (!row) {
      return null;
    }

    return {
      eventId: row.eventId,
      occurredAt: row.occurredAt.toISOString(),
      category: row.category,
      action: row.action,
      outcome: row.outcome as AuditEventOutcome,
      severity: row.severity as AuditEventSeverity,
      scopeAccountId: row.scopeAccountId,
      scopeDeviceId: row.scopeDeviceId,
      entityType: row.entityType ?? undefined,
      entityId: row.entityId ?? undefined,
      sessionId: row.sessionId ?? undefined,
      requestId: row.requestId ?? undefined,
      correlationId: row.correlationId ?? undefined,
      relatedRecordId: row.relatedRecordId ?? undefined,
      metadata: parseAuditMetadata(row.metadataJson),
      retentionUntilAt: row.retentionUntilAt.toISOString(),
    };
  }

  /**
   * Performs best-effort retention cleanup with a fixed minimum interval.
   *
   * @returns Void.
   */
  private async maybeSweepExpiredEvents(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastRetentionSweepAtMs < AUDIT_RETENTION_SWEEP_INTERVAL_MS) {
      return;
    }

    this.lastRetentionSweepAtMs = nowMs;

    try {
      const db = this.getDbClient();
      await db.auditEvent.deleteMany({
        where: {
          retentionUntilAt: {
            lt: new Date(nowMs),
          },
        },
      });
    } catch (error: unknown) {
      console.error('[audit] Failed to sweep expired audit events.', error);
    }
  }
}
