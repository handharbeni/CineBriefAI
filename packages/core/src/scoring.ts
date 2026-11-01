// Candidate clip scoring: deterministic structural scoring over transcript
// segments + scene boundaries, aligned to campaign brief constraints.
// LLM semantic scores layer on top of this base score in the worker.
import { z } from 'zod';

export const TranscriptSegmentSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const SceneBoundarySchema = z.object({ timeS: z.number().min(0), score: z.number().optional() });

export const ClipStructureSchema = z.object({
  hookStartS: z.number().min(0),
  hookEndS: z.number().min(0),
  bodyEndS: z.number().min(0),
  ctaStartS: z.number().min(0),
  ctaEndS: z.number().min(0),
});
export type ClipStructure = z.infer<typeof ClipStructureSchema>;

export const CandidateSchema = z.object({
  id: z.string(),
  sourceAssetId: z.string(),
  startS: z.number().min(0),
  endS: z.number().min(0),
  title: z.string().default(''),
  reason: z.string().default(''),
  structure: ClipStructureSchema,
  baseScore: z.number().min(0).max(100),
  semanticScore: z.number().min(0).max(100).optional(),
  finalScore: z.number().min(0).max(100),
  compliancePassed: z.boolean().default(true),
  violations: z.array(z.any()).default([]),
  transcript: z.array(TranscriptSegmentSchema).default([]),
});
export type Candidate = z.infer<typeof CandidateSchema>;

interface ScoreInput {
  start: number;
  end: number;
  segments: TranscriptSegment[];
  scenes: number[]; // sorted scene boundary times
  videoDurationS: number;
  minDurationS: number;
  maxDurationS: number;
  ctaKeywords: string[]; // e.g. ["link", "subscribe", "sign up"]
}

const HOOK_WORDS = ['you', 'stop', 'never', 'why', 'how', 'secret', 'mistake', 'before', 'watch', 'did you know'];

export function scoreCandidateWindow(o: ScoreInput): { baseScore: number; structure: ClipStructure; reason: string } {
  const winSegs = o.segments.filter((s) => s.end > o.start && s.start < o.end);
  const dur = o.end - o.start;
  const reasons: string[] = [];
  let score = 50;

  // Duration fit vs brief window
  if (dur >= o.minDurationS && dur <= o.maxDurationS) { score += 15; reasons.push('duration fits brief'); }
  else if (dur < o.minDurationS) score -= 20;
  else score -= 10;

  // Hook quality: first ~3s contains question/power words
  const hookText = winSegs.filter((s) => s.start < o.start + 3).map((s) => s.text.toLowerCase()).join(' ');
  const hookHits = HOOK_WORDS.filter((w) => hookText.includes(w)).length;
  if (hookHits > 0) { score += Math.min(15, hookHits * 5); reasons.push(`hook keywords x${hookHits}`); }

  // Complete-sentence start: prefer starting at a segment boundary within 0.5s
  const startsClean = winSegs.length > 0 && Math.abs(winSegs[0].start - o.start) < 0.5;
  if (startsClean) { score += 8; reasons.push('clean sentence start'); } else score -= 8;

  // Ends near a scene cut → less jarring
  const nearestCut = o.scenes.reduce((best, t) => (Math.abs(t - o.end) < Math.abs(best - o.end) ? t : best), Infinity as unknown as number);
  if (isFinite(nearestCut) && Math.abs(nearestCut - o.end) < 1.0) { score += 7; reasons.push('ends near scene cut'); }

  // CTA presence near end (relative to the last segment's actual end, so windows
  // that extend slightly past speech still detect their tail content)
  const lastSegEnd = winSegs.length ? Math.max(...winSegs.map((s) => s.end)) : o.end;
  const tailWindow = Math.min(6, dur * 0.25);
  const tailText = winSegs.filter((s) => s.end > lastSegEnd - tailWindow).map((s) => s.text.toLowerCase()).join(' ');
  const ctaHit = o.ctaKeywords.some((k) => tailText.includes(k.toLowerCase()));
  if (ctaHit) { score += 12; reasons.push('CTA language present in tail'); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const hookEndS = Math.min(o.end, o.start + Math.max(2, dur * 0.15));
  const ctaStartS = Math.max(hookEndS, o.end - Math.min(5, dur * 0.2));
  const structure: ClipStructure = {
    hookStartS: o.start,
    hookEndS,
    bodyEndS: ctaStartS,
    ctaStartS,
    ctaEndS: o.end,
  };
  return { baseScore: score, structure, reason: reasons.join('; ') || 'no positive signals' };
}

/** Slide windows over transcript segment boundaries to enumerate candidates. */
export function enumerateCandidateWindows(segments: TranscriptSegment[], minS: number, maxS: number, stepLimit = 40): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < segments.length && out.length < stepLimit; i++) {
    for (let j = i; j < segments.length; j++) {
      const start = segments[i].start;
      const end = segments[j].end;
      const dur = end - start;
      if (dur < minS) continue;
      if (dur > maxS) break;
      const key = `${start.toFixed(2)}-${end.toFixed(2)}`;
      if (!seen.has(key)) { seen.add(key); out.push({ start, end }); }
    }
  }
  return out;
}
