import { describe, it, expect } from 'vitest';
import { scoreCandidateWindow, enumerateCandidateWindows } from '../src/scoring';

const segments = [
  { start: 0, end: 2.5, text: 'Why do most marketers fail at video?' },
  { start: 2.5, end: 6, text: 'They never hook the viewer in the first three seconds.' },
  { start: 6, end: 10, text: 'But there is a simple framework that fixes this.' },
  { start: 10, end: 14, text: 'Watch until the end and grab the free template below.' },
];

describe('candidate scoring', () => {
  it('rewards clean starts, hooks and CTA tails', () => {
    const r = scoreCandidateWindow({
      start: 0, end: 14, segments, scenes: [14.2], videoDurationS: 60,
      minDurationS: 10, maxDurationS: 30, ctaKeywords: ['link', 'below', 'grab'],
    });
    expect(r.baseScore).toBeGreaterThanOrEqual(80);
    expect(r.reason).toContain('CTA');
    expect(r.structure.hookEndS).toBeGreaterThan(r.structure.hookStartS);
    expect(r.structure.ctaStartS).toBeLessThan(r.structure.ctaEndS);
  });
  it('penalizes windows shorter than brief minimum', () => {
    const r = scoreCandidateWindow({
      start: 0.3, end: 5, segments, scenes: [], videoDurationS: 60,
      minDurationS: 10, maxDurationS: 30, ctaKeywords: [],
    });
    expect(r.baseScore).toBeLessThan(50);
  });
  it('enumerates windows within duration bounds only', () => {
    const wins = enumerateCandidateWindows(segments, 5, 12);
    for (const w of wins) {
      expect(w.end - w.start).toBeGreaterThanOrEqual(5);
      expect(w.end - w.start).toBeLessThanOrEqual(12);
    }
    expect(wins.length).toBeGreaterThan(0);
  });
});
