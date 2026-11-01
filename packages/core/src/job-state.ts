// Job state machine shared by API + Worker. States are persisted in DB;
// transitions are validated here so no component can skip or regress states illegally.
import { z } from 'zod';

export const JobType = z.enum(['CLIP_ANALYSIS', 'CLIP_RENDER', 'GENERATION']);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum([
  'QUEUED',
  'VALIDATING',
  'PROBING',        // ffprobe metadata
  'TRANSCRIBING',   // STT
  'SCENING',        // scene detection
  'ANALYZING',      // vision / LLM multimodal analysis
  'SCORING',        // candidate scoring + hook/body/cta planning
  'AWAITING_REVIEW',// human review gate
  'RENDERING',      // ffmpeg render (clip) or assembly (generation)
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type JobStatus = z.infer<typeof JobStatus>;

// Allowed forward transitions per job type. FAILED/CANCELLED reachable from any non-terminal.
const TRANSITIONS: Record<JobType, JobStatus[][]> = {
  CLIP_ANALYSIS: [
    ['QUEUED', 'VALIDATING'],
    ['VALIDATING', 'PROBING'],
    ['PROBING', 'TRANSCRIBING'],
    ['TRANSCRIBING', 'SCENING'],
    ['SCENING', 'ANALYZING'],
    ['ANALYZING', 'SCORING'],
    ['SCORING', 'AWAITING_REVIEW'],
  ],
  CLIP_RENDER: [
    ['QUEUED', 'VALIDATING'],
    ['VALIDATING', 'RENDERING'],
    ['RENDERING', 'COMPLETED'],
  ],
  GENERATION: [
    ['QUEUED', 'VALIDATING'],
    ['VALIDATING', 'ANALYZING'], // concept/storyboard generation via LLM
    ['ANALYZING', 'RENDERING'],   // asset gen + TTS + assembly
    ['RENDERING', 'COMPLETED'],
  ],
};

const TERMINAL: JobStatus[] = ['COMPLETED', 'CANCELLED'];

export function allowedTransitions(from: JobStatus): JobStatus[] {
  if (TERMINAL.includes(from)) return [];
  const next = new Set<JobStatus>(['FAILED']);
  for (const t of Object.values(TRANSITIONS)) {
    if (t.some(([f]) => f === from)) {
      const found = t.find(([f]) => f === from)!;
      next.add(found[1]);
    }
  }
  return [...next];
}

export function canTransition(type: JobType, from: JobStatus, to: JobStatus): boolean {
  if (to === 'CANCELLED') return !TERMINAL.includes(from);
  if (from === to) return true; // idempotent re-set of same state
  const table = TRANSITIONS[type];
  return table.some(([f, t]) => f === from && t === to) || (to === 'FAILED' && !TERMINAL.includes(from));
}

/** Returns the ordered pipeline states for a job type (for UI progress display). */
export function pipelineStates(type: JobType): JobStatus[] {
  return TRANSITIONS[type].flat().filter((v, i, a) => a.indexOf(v) === i);
}

export const JobEventSchema = z.object({
  jobId: z.string().uuid(),
  from: JobStatus,
  to: JobStatus,
  at: z.string().datetime(),
  message: z.string().optional(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;
