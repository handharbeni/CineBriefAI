// End-to-end pipeline integration test on REAL media (data/sample.mp4 generated
// by scripts/make-test-video.sh — 3 hard-cut scenes + sine tone audio).
// No mocks: ffprobe/ffmpeg run for real. STT is provider-gated; when no provider
// is configured we exercise the transcript-free path honestly (empty segments,
// scene-seeded candidates) rather than fabricating a transcript.
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { FFprobeService } from '../src/ffprobe-service';
import { detectSceneSegments } from '../src/scenes';
import { generateCandidates, measureAudioEnergy, padToSentenceBoundaries, sceneCompleteness } from '../src/candidates';
import type { TranscriptSegment } from '@clipforge/core';

const SAMPLE = path.resolve(__dirname, '../../../data/sample.mp4');

beforeAll(() => {
  if (!existsSync(SAMPLE)) {
    execSync('bash scripts/make-test-video.sh data/sample.mp4', { cwd: path.resolve(__dirname, '../../..') });
  }
});

describe('FFprobeService (real media)', () => {
  it('extracts strongly-typed metadata from the sample mp4', async () => {
    const svc = new FFprobeService();
    const meta = await svc.probe({ pathOrUrl: SAMPLE });
    expect(meta.durationS).toBeGreaterThan(10);
    expect(meta.durationS).toBeLessThan(15);
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    expect(meta.fps).toBeCloseTo(30, 0);
    expect(meta.videoCodec).toBe('h264');
    expect(meta.audioCodec).toBe('aac');
    expect(meta.hasAudio).toBe(true);
    expect(meta.bitrateBps).toBeGreaterThan(10_000);
    expect(meta.sizeBytes).toBe((await stat(SAMPLE)).size);
    expect(meta.formatName).toContain('mp4');
  }, 30_000);

  it('rejects non-media files with a clear error', async () => {
    const svc = new FFprobeService();
    await expect(svc.probeLocal(__filename)).rejects.toThrow(/ffprobe|No video stream/i);
  });
});

describe('Scene detection (real ffmpeg)', () => {
  it('finds the two hard cuts at ~4s and ~8s with keyframe thumbnails', async () => {
    const svc = new FFprobeService();
    const meta = await svc.probe({ pathOrUrl: SAMPLE });
    const scenes = await detectSceneSegments(SAMPLE, meta.durationS, {
      threshold: 0.3,
      thumbDir: '/tmp/clipforge-test-thumbs',
    });
    // 3 concatenated synthetic sources → at least 2 detected boundaries
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    // Scenes tile the timeline
    expect(scenes[0].startTime).toBe(0);
    expect(scenes[scenes.length - 1].endTime).toBeCloseTo(meta.durationS, 1);
    for (let i = 1; i < scenes.length; i++) {
      expect(scenes[i].startTime).toBeCloseTo(scenes[i - 1].endTime, 2);
    }
    // Cut near 4s and 8s within tolerance
    const starts = scenes.map((s) => s.startTime);
    expect(starts.some((t) => Math.abs(t - 4) < 0.5)).toBe(true);
    expect(starts.some((t) => Math.abs(t - 8) < 0.5)).toBe(true);
    // Thumbnails are real extracted JPEG files
    for (const sc of scenes) {
      expect(existsSync(sc.thumbnailPath)).toBe(true);
      expect((await stat(sc.thumbnailPath)).size).toBeGreaterThan(500);
    }
  }, 60_000);
});

describe('Candidate generation', () => {
  const segs: TranscriptSegment[] = [
    { start: 0.0, end: 3.8, text: 'Why do most clips flop right at the start?' },
    { start: 4.2, end: 7.6, text: 'You need a hook that stops the scroll.' },
    { start: 8.1, end: 11.9, text: 'Subscribe and grab the link below.' },
  ];

  it('measures real audio energy on the tone track', async () => {
    const e = await measureAudioEnergy(SAMPLE, 1, 3);
    expect(e).not.toBeNull();
    expect(e!).toBeGreaterThan(0.5); // loud sine tone
    const silentish = await measureAudioEnergy(SAMPLE, 11.0, 11.9);
    expect(silentish).not.toBeNull(); // audio stream covers whole file
  }, 30_000);

  it('pads windows to sentence boundaries without cutting mid-sentence', () => {
    const padded = padToSentenceBoundaries({ start: 4.4, end: 7.2 }, segs, 3, 15, 12);
    expect(padded.start).toBe(4.2); // snapped back to segment start
    expect(padded.end).toBe(7.6); // extended past raw end to complete sentence
  });

  it('computes scene completeness', () => {
    const scenes = [
      { startTime: 0, endTime: 4, thumbnailPath: '' },
      { startTime: 4, endTime: 8, thumbnailPath: '' },
    ];
    expect(sceneCompleteness(scenes, 4, 8)).toBe(1);
    expect(sceneCompleteness(scenes, 2, 6)).toBeCloseTo(0.5, 5);
  });

  it('generates scored candidates from transcript + real scenes', async () => {
    const svc = new FFprobeService();
    const meta = await svc.probe({ pathOrUrl: SAMPLE });
    const scenes = await detectSceneSegments(SAMPLE, meta.durationS, {
      threshold: 0.3,
      thumbDir: '/tmp/clipforge-test-thumbs',
    });
    const cands = await generateCandidates({
      sourcePath: SAMPLE,
      videoDurationS: meta.durationS,
      hasAudio: meta.hasAudio,
      segments: segs,
      scenes,
      minDurationS: 3,
      maxDurationS: 15,
    });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.endS - c.startS).toBeGreaterThanOrEqual(3);
      expect(c.endS - c.startS).toBeLessThanOrEqual(15);
      expect(c.finalScore).toBeGreaterThanOrEqual(0);
      expect(c.finalScore).toBeLessThanOrEqual(100);
      expect(c.audioEnergy).not.toBeNull();
      expect(c.structure.hookEndS).toBeGreaterThan(c.structure.hookStartS);
      expect(c.transcript.length).toBeGreaterThan(0);
    }
    // The CTA-bearing tail window should be discoverable
    expect(cands.some((c) => c.reason.includes('CTA')) || cands.some((c) => c.title.includes('Subscribe'))).toBe(true);
  }, 120_000);

  it('falls back to scene-seeded candidates when there is no transcript', async () => {
    const svc = new FFprobeService();
    const meta = await svc.probe({ pathOrUrl: SAMPLE });
    const scenes = await detectSceneSegments(SAMPLE, meta.durationS, {
      threshold: 0.3,
      thumbDir: '/tmp/clipforge-test-thumbs',
    });
    const cands = await generateCandidates({
      sourcePath: SAMPLE,
      videoDurationS: meta.durationS,
      hasAudio: meta.hasAudio,
      segments: [],
      scenes,
      minDurationS: 3,
      maxDurationS: 10,
    });
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => c.transcript.length === 0)).toBe(true);
  }, 120_000);
});
