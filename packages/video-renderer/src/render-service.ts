// RenderService — turns a CandidateClip + SubtitleConfig into a finished 9:16 MP4.
// SECURITY MODEL:
//  - All ffmpeg invocations go through @clipforge/media's execFile wrappers (array args, never shell:true).
//  - Subtitle files are written by us into a private work dir; paths are escaped for the subtitles filter.
//  - Inputs validated to exist and pass magic-byte signature checks before rendering.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { renderClip, ffprobe, detectFileKind, ALLOWED_VIDEO_KINDS } from '@clipforge/media';
import {
  toSRT,
  toASS,
  type SubtitleDoc,
} from '@clipforge/core';
import type { CandidateClip } from '@clipforge/media-pipeline';

export interface RenderRequest {
  sourcePath: string; // local file (downloaded from storage by the worker beforehand)
  candidate: Pick<CandidateClip, 'startS' | 'endS'>;
  subtitles?: SubtitleDoc; // word-level cue model from core
  aspectRatio?: '9:16' | '1:1' | '16:9';
  targetHeight?: number; // default 1280 (720x1280); set 1920 for full-HD vertical
  burnSubtitles?: boolean; // false → sidecar SRT/ASS only
  workDir: string;
  outPath: string;
}

export interface RenderResult {
  outPath: string;
  srtPath?: string;
  assPath?: string;
  durationS: number;
  width: number;
  height: number;
  sizeBytes: number;
}

/** Build word-level cues for a clip window from its transcript segments. */
export function subtitleDocFromCandidate(
  candidate: CandidateClip,
  overrides: Partial<SubtitleDoc> = {},
): SubtitleDoc {
  const t0 = candidate.startS;
  const cues = candidate.transcript
    .filter((s) => s.end > t0 && s.start < candidate.endS)
    .map((s, i) => {
      const start = Math.max(s.start, t0) - t0;
      const end = Math.min(s.end, candidate.endS) - t0;
      // Use real word timings when STT provided them; otherwise split evenly across words.
      const wordsText = s.text.split(/\s+/).filter(Boolean);
      const words = (s as any).words?.length
        ? (s as any).words.map((w: any) => ({
            text: w.text,
            startS: Math.max(0, (w.startS ?? w.start ?? s.start) - t0),
            endS: Math.max(0, Math.min(end, (w.endS ?? w.end ?? s.end) - t0)),
          }))
        : wordsText.map((text: string, j: number) => ({
            text,
            startS: start + ((end - start) * j) / wordsText.length,
            endS: start + ((end - start) * (j + 1)) / wordsText.length,
          }));
      return { id: `c-${i}`, words: words.length ? words : [{ text: s.text, startS: start, endS: end }], style: 'default' as const };
    });
  return {
    cues,
    highlightMode: 'word',
    fontSize: 42,
    fontColor: '#FFFFFF',
    highlightColor: '#FFD400',
    outlineColor: '#000000',
    marginV: 120,
    ...overrides,
  } as SubtitleDoc;
}

export class RenderService {
  async render(req: RenderRequest): Promise<RenderResult> {
    // 1. Validate input is a real video file (magic bytes, not extension trust)
    const kind = await detectFileKind(req.sourcePath);
    if (!ALLOWED_VIDEO_KINDS.includes(kind)) {
      throw new Error(`Source file signature "${kind}" is not an allowed video container`);
    }

    await mkdir(req.workDir, { recursive: true });
    const uid = randomUUID().slice(0, 8);

    // 2. Subtitle sidecars + optional ASS burn-in
    let assPath: string | undefined;
    let srtPath: string | undefined;
    if (req.subtitles && req.subtitles.cues.length) {
      const srtContent = toSRT(req.subtitles);
      const assContent = toASS(req.subtitles);
      srtPath = `${req.workDir}/subs-${uid}.srt`;
      assPath = `${req.workDir}/subs-${uid}.ass`;
      await writeFile(srtPath, srtContent);
      await writeFile(assPath, assContent);
    }

    // 3. Extract time range + center-crop to aspect + scale + burn subs, H.264/AAC
    await renderClip(req.sourcePath, req.outPath, {
      startS: req.candidate.startS,
      endS: req.candidate.endS,
      aspectRatio: req.aspectRatio ?? '9:16',
      targetHeight: req.targetHeight ?? 1280,
      burnSubtitlesAss: req.burnSubtitles !== false ? assPath : undefined,
    });

    // 4. Verify the output with real ffprobe (never trust ffmpeg exit code alone)
    const meta = await ffprobe(req.outPath);
    return {
      outPath: req.outPath,
      srtPath,
      assPath,
      durationS: meta.durationS,
      width: meta.width,
      height: meta.height,
      sizeBytes: meta.sizeBytes,
    };
  }
}

/** Cleanup helper for worker temp dirs (best-effort, non-fatal). */
export async function cleanupWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
