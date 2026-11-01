import { PrismaClient, JobStatus } from '@prisma/client';

export * from '@prisma/client';

/** Single shared Prisma client (connection-pooled). */
export const prisma = new PrismaClient();

/**
 * Persist a validated job state transition. The core package owns the rules;
 * this helper is the only sanctioned way to move a job forward so that every
 * component (API, worker) writes state consistently with an audit event.
 * Uses optimistic revision check for retry-safety: if `expectedRevision` is
 * provided and does not match, the transition is rejected (stale worker run).
 */
export async function transitionJob(
  db: PrismaClient,
  opts: {
    jobId: string;
    to: JobStatus;
    canTransition: (type: any, from: any, to: any) => boolean;
    expectedRevision?: number;
    message?: string;
    result?: object;
    error?: string;
  },
): Promise<{ ok: boolean; status: JobStatus; revision: number }> {
  return db.$transaction(async (tx) => {
    const job = await tx.job.findUnique({ where: { id: opts.jobId } });
    if (!job) throw new Error(`Job ${opts.jobId} not found`);
    if (job.status === opts.to && !opts.error) {
      // Idempotent replay: same target state already persisted.
      return { ok: true, status: job.status, revision: job.revision };
    }
    if (opts.expectedRevision !== undefined && job.revision !== opts.expectedRevision) {
      return { ok: false, status: job.status, revision: job.revision };
    }
    if (!opts.canTransition(job.type, job.status, opts.to)) {
      throw new Error(`Illegal transition ${job.status} -> ${opts.to} for job ${job.id}`);
    }
    const updated = await tx.job.update({
      where: { id: job.id },
      data: {
        status: opts.to,
        revision: { increment: 1 },
        ...(opts.result !== undefined ? { result: opts.result as any } : {}),
        ...(opts.error !== undefined ? { error: opts.error } : {}),
      },
    });
    await tx.jobEvent.create({
      data: { jobId: job.id, from: job.status, to: opts.to, message: opts.message },
    });
    return { ok: true, status: updated.status, revision: updated.revision };
  });
}
