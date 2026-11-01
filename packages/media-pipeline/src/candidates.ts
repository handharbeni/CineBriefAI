// Candidate generation: combine transcript segments + scene boundaries into
// CandidateClip objects. Real signals only:
//  - audio energy per window via ffmpeg astats (RMS dB, converted to 0..1)
//  - scene completeness (window aligned to scene cuts)
//  - transcript density + structural scoring from @clipforge/core
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  enumerateCandidateWindows,
  scoreCandidateWindow,
  type TranscriptSegment,
} from '@clipforge/core';
import type { Scene } from './scenes';

const pexec = promisify(execFile);

export interface CandidateClip {
  id: string;
  startS: number;
  endS: number;
  durationS: number;
  title: string;
  reason: string;
  structure: {
    hookStartS: number;
    hookEndS: number;
    bodyEndS: number;
    ctaStartS: number;
    ctaEndS: number;
  };
  baseScore: number; // structural score from core (0..100)
  audioEnergy: number | null; // mean RMS in [0..1] over the window, null if no audio
  sceneCompleteness: number; // fraction of window covered by whole scenes [0..1]
  finalScore: number; // blended 0..100
  transcript: TranscriptSegment[];
}

export interface GenerateCandidatesInput {
  sourcePath: string;
  videoDurationS: number;
  hasAudio: boolean;
  segments: TranscriptSegment[];
  scenes: Scene[];
  minDurationS?: number; // default 3
  maxDurationS?: number; // default 15
  ctaKeywords?: string[];
  maxCandidates?: number;
}

/**
 * Measure real audio loudness for a window using ffmpeg's astats filter.
 * Returns mean RMS level mapped from [-60..0 dB] to [0..1], or null when the
 * source has no audio stream. Never fabricated.
 */
export async function measureAudioEnergy(
  path: string,
  startS: number,
  endS: number,
): Promise<number | null> {
  const dur = endS - startS;
  if (!(dur > 0)) throw new Error('measureAudioEnergy: invalid window');
  try {
    const { stderr } = await pexec(
      'ffmpeg',
      [
        '-v', 'info', '-ss', String(startS), '-t', String(dur), '-i', path,
        '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-',
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    // Parse "RMS level dB:" lines from the astats summary (per-channel + overall).
    const rmsMatches = [...stderr.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)];
    if (!rmsMatches.length) return null;
    const vals = rmsMatches.map((m) => parseFloat(m[1])).filter((n) => Number.isFinite(n));
    if (!vals.length) return null;
    const meanDb = vals.reduce((a, b) => a + b, 0) / vals.length;
    // Map dB floor -60 -> 0, 0 dB -> 1
    return Math.max(0, Math.min(1, (meanDb + 60) / 60));
  } catch {
    // Missing audio stream or decode error -> honestly report "unknown"
    return null;
  }
}

/** Fraction of [start,end] that lies inside complete detected scenes. */
export function sceneCompleteness(scenes: Scene[], start: number, end: number): number {
  if (!scenes.length || end <= start) return 0;
  // Fraction of the window covered by scenes, minus a penalty for each scene
  // boundary that falls strictly inside the window (i.e. the clip cuts a shot).
  let covered = 0;
  let cutsInside = 0;
  for (const s of scenes) {
    const lo = Math.max(start, s.startTime);
    const hi = Math.min(end, s.endTime);
    if (hi > lo) covered += hi - lo;
    if (s.startTime > start && s.startTime < end) cutsInside++;
  }
  const coverage = Math.min(1, covered / (end - start));
  return Math.max(0, coverage - cutsInside * 0.5);
}

/**
 * Pad a raw window to sentence/segment boundaries so we never cut mid-sentence:
 * snap start back to segment start and absorb trailing segments until a
 * sentence terminator appears (bounded by hard max / end of media).
 */
export function padToSentenceBoundaries(
  w: { start: number; end: number },
  segments: TranscriptSegment[],
  hardMin: number,
  hardMax: number,
  videoDurationS: number,
): { start: number; end: number } {
  const inWin = segments.filter((s) => s.end > w.start && s.start < w.end);
  if (!inWin.length) return w;
  let start = Math.max(0, Math.min(w.start, inWin[0].start));
  let end = Math.max(w.end, inWin[inWin.length - 1].end);
  const TERMINATORS = /[.!?]["')\]]?$/;
  for (;;) {
    const last = segments.find((s) => Math.abs(s.end - end) < 0.01);
    if (!last || TERMINATORS.test(last.text.trim())) break;
    const next = segments.find((s) => s.start >= end - 0.05 && s.start < end + 1.5);
    if (!next) break;
    if (next.end - start > hardMax) break;
    end = next.end;
  }
  if (end - start > hardMax) end = Math.min(videoDurationS, start + hardMax);
  if (end - start < hardMin) end = Math.min(videoDurationS, start + hardMin);
  return {
    start: Math.round(start * 1000) / 1000,
    end: Math.round(Math.min(end, videoDurationS) * 1000) / 1000,
  };
}

export async function generateCandidates(
  input: GenerateCandidatesInput,
): Promise<CandidateClip[]> {
  const minS = input.minDurationS ?? 3;
  const maxS = input.maxDurationS ?? 15;
  const cta = input.ctaKeywords ?? ['link', 'subscribe', 'follow', 'sign up', 'checkout'];
  const sceneTimes = input.scenes.map((s) => s.startTime);

  const rawWindows = enumerateCandidateWindows(input.segments, minS, maxS);
  // Also seed windows from scene boundaries when transcript is sparse
  if (rawWindows.length === 0 && input.scenes.length) {
    for (let i = 0; i < input.scenes.length; i++) {
      const start = input.scenes[i].startTime;
      const end = Math.min(input.videoDurationS, start + maxS);
      if (end - start >= minS) rawWindows.push({ start, end });
    }
  }

  const out: CandidateClip[] = [];
  for (const raw of rawWindows) {
    const win = padToSentenceBoundaries(raw, input.segments, minS, maxS, input.videoDurationS);
    if (win.end - win.start < minS) continue;

    const { baseScore, structure, reason } = scoreCandidateWindow({
      start: win.start,
      end: win.end,
      segments: input.segments,
      scenes: sceneTimes,
      videoDurationS: input.videoDurationS,
      minDurationS: minS,
      maxDurationS: maxS,
      ctaKeywords: cta,
    });

    const completeness = sceneCompleteness(input.scenes, win.start, win.end);
    const energy = input.hasAudio
      ? await measureAudioEnergy(input.sourcePath, win.start, win.end)
      : null;

    // Blend: structural 60%, scene completeness 20%, audio energy 20% (if measured)
    let final = baseScore * 0.6 + completeness * 100 * 0.2;
    if (energy !== null) final += energy * 100 * 0.2;
    else final += baseScore * 0.2; // fall back to structural share when silent

    const winSegs = input.segments.filter((s) => s.end > win.start && s.start < win.end);
    const firstText = winSegs[0]?.text?.trim() ?? '';
    out.push({
      id: randomUUID(),
      startS: win.start,
      endS: win.end,
      durationS: Math.round((win.end - win.start) * 1000) / 1000,
      title: firstText ? firstText.slice(0, 80) : `Scene @ ${win.start.toFixed(1)}s`,
      reason: [
        reason,
        `scene coverage ${(completeness * 100).toFixed(0)}%`,
        energy !== null ? `audio energy ${(energy * 100).toFixed(0)}%` : 'no audio',
      ]
        .filter(Boolean)
        .join('; '),
      structure,
      baseScore,
      audioEnergy: energy,
      sceneCompleteness: Math.round(completeness * 1000) / 1000,
      finalScore: Math.round(Math.max(0, Math.min(100, final))),
      transcript: winSegs,
    });
    if (input.maxCandidates && out.length >= input.maxCandidates) break;
  }

  // Deduplicate heavily overlapping windows (IoU > 0.7 keeps higher score)
  out.sort((a, b) => b.finalScore - a.finalScore);
  const kept: CandidateClip[] = [];
  for (const c of out) {
    const overlaps = kept.some((k) => {
      const inter = Math.min(k.endS, c.endS) - Math.max(k.startS, c.startS);
      const union = Math.max(k.endS, c.endS) - Math.min(k.startS, c.startS);
      return union > 0 && inter / union > 0.7;
    });
    if (!overlaps) kept.push(c);
  }
  return kept.slice(0, 20);
}
