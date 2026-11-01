import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ffprobe, detectScenes, renderClip, extractFrames } from '../src/ffmpeg';

const dir = mkdtempSync(`${tmpdir()}/ff-`);
const src = `${dir}/src.mp4`;

beforeAll(() => {
  // Real test media: 8s 640x480 video with tone audio + a hard color change at t=4
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    "testsrc2=size=640x480:rate=25:duration=4", '-f', 'lavfi', '-i',
    "color=c=red:size=640x480:rate=25:duration=4", '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=8', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src],
    { stdio: 'pipe' });
}, 120_000);

describe('ffmpeg pipeline on real media', () => {
  it('ffprobe reads duration/resolution/audio', async () => {
    const m = await ffprobe(src);
    expect(m.durationS).toBeCloseTo(8, 0);
    expect(m.width).toBe(640);
    expect(m.hasAudio).toBe(true);
    expect(m.videoCodec).toBe('h264');
  });
  it('detects the scene change near t=4', async () => {
    const scenes = await detectScenes(src, 30);
    expect(scenes.some((t) => Math.abs(t - 4) < 0.5)).toBe(true);
  });
  it('extracts frames', async () => {
    const out = mkdtempSync(`${tmpdir()}/frames-`);
    const files = await extractFrames(src, [1, 5], out);
    expect(files.length).toBe(2);
    expect(existsSync(files[0])).toBe(true);
  });
  it('renders a 9:16 cropped subtitle-free clip of correct duration', async () => {
    const out = `${dir}/clip.mp4`;
    await renderClip(src, out, { startS: 2, endS: 6, aspectRatio: '9:16', targetHeight: 720 });
    const m = await ffprobe(out);
    expect(m.durationS).toBeCloseTo(4, 0);
    expect(m.height).toBe(720);
    expect(Math.round((m.width / m.height) * 100) / 100).toBeCloseTo(9 / 16, 1);
  });
});
