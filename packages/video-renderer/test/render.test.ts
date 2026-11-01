// Real-media render tests: renders a 9:16 clip with burned-in subtitles from
// data/sample.mp4 and verifies the OUTPUT with ffprobe + pixel sampling.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { ffprobe } from '@clipforge/media';
import type { CandidateClip } from '@clipforge/media-pipeline';
import { RenderService, subtitleDocFromCandidate } from '../src/render-service';

const pexec = promisify(execFile);

const SAMPLE = path.resolve(__dirname, '../../../data/sample.mp4');

function makeCandidate(): CandidateClip {
  // Second scene of sample.mp4: [4s, 8s], three "sentences" with real-ish timings.
  const transcript = [
    { start: 4.0, end: 5.4, text: 'This is the hook line.' },
    { start: 5.4, end: 7.0, text: 'Here comes the body of the message.' },
    { start: 7.0, end: 7.9, text: 'Click the link now.' },
  ];
  return {
    id: 'test-cand-1',
    startS: 4.0,
    endS: 8.0,
    durationS: 4.0,
    title: 'Test candidate',
    reason: 'unit test',
    structure: {
      hookStartS: 4.0,
      hookEndS: 5.4,
      bodyEndS: 7.0,
      ctaStartS: 7.0,
      ctaEndS: 7.9,
    },
    baseScore: 70,
    audioEnergy: null,
    sceneCompleteness: 1,
    finalScore: 70,
    transcript,
  };
}

describe('RenderService (real ffmpeg)', () => {
  let workDir: string;

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) throw new Error(`Missing test media: ${SAMPLE}`);
    workDir = await mkdtempSafe();
  });

  it('renders a 9:16 H.264/AAC MP4 with burned-in subtitles, verified by ffprobe', async () => {
    const svc = new RenderService();
    const candidate = makeCandidate();
    const subs = subtitleDocFromCandidate(candidate);
    const outPath = path.join(workDir, 'clip-916.mp4');

    const result = await svc.render({
      sourcePath: SAMPLE,
      candidate,
      subtitles: subs,
      aspectRatio: '9:16',
      targetHeight: 1280,
      burnSubtitles: true,
      workDir,
      outPath,
    });

    // ffprobe verification of the actual rendered file
    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(result.durationS).toBeCloseTo(4.0, 0); // ±~1s tolerance for keyframe seek
    expect(result.durationS).toBeGreaterThan(3.0);
    expect(result.durationS).toBeLessThan(5.2);
    expect(result.sizeBytes).toBeGreaterThan(10_000); // non-trivial output

    const meta = await ffprobe(outPath);
    const codecs = await pexec('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outPath,
    ]);
    expect(codecs.stdout.trim()).toBe('h264');
    const acodecs = await pexec('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outPath,
    ]);
    expect(acodecs.stdout.trim()).toBe('aac');
    expect(meta.hasAudio).toBe(true);

    // Subtitle burn-in proof: sample frames inside subtitle time windows vs.
    // outside them. ASS cues cover ~0..3.9s of the clip; grab one frame at 2s
    // (subs active) and compare white-pixel density in the bottom band against
    // a frame near the very end where cues have ended.
    const fSub = path.join(workDir, 'frame-sub.png');
    const fNo = path.join(workDir, 'frame-nosub.png');
    await pexec('ffmpeg', ['-y', '-ss', '2.0', '-i', outPath, '-frames:v', '1', fSub]);
    await pexec('ffmpeg', ['-y', '-ss', '3.95', '-i', outPath, '-frames:v', '1', fNo]);

    const whiteCount = async (file: string) => {
      // crop bottom band (subtitle area), threshold to near-white, count nonzero pixels
      const { stdout } = await pexec('ffmpeg', [
        '-v', 'error', '-i', file,
        '-vf', 'crop=iw:ih/6:0:ih*5/6,threshold=eq_mode=plus:threshold=230,format=gray',
        '-f', 'rawvideo', '-',
      ]);
      // raw gray bytes in buffer via stdout is not available through execFile strings reliably;
      // instead use signalstats YAVG on the band which is deterministic.
      return stdout.length;
    };
    // Use PSNR-free approach: measure average luma of the bottom band with signalstats.
    const bandYavg = async (file: string) => {
      const { stderr } = await pexec('ffmpeg', [
        '-v', 'info', '-i', file,
        '-vf', 'crop=iw:ih/6:0:ih*5/6,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
        '-f', 'null', '-',
      ]).catch((e: any) => ({ stderr: String(e?.stderr ?? ''), stdout: '' }));
      const m = stderr.match(/YAVG=([\d.]+)/);
      return m ? parseFloat(m[1]) : NaN;
    };
    void whiteCount; // replaced by bandYavg approach below

    const yWithSubs = await bandYavg(fSub);
    const yWithout = await bandYavg(fNo);
    expect(Number.isFinite(yWithSubs)).toBe(true);
    expect(Number.isFinite(yWithout)).toBe(true);
    // Burned white subtitle text must raise mean luma of the bottom band.
    // Sample has a solid-color background per scene; difference should be clear.
    expect(yWithSubs).toBeGreaterThan(yWithout);

    // Sidecars exist and are well-formed
    expect(result.srtPath && existsSync(result.srtPath)).toBe(true);
    expect(result.assPath && existsSync(result.assPath)).toBe(true);
    const srt = readFileSync(result.srtPath!, 'utf8');
    expect(srt).toContain('-->');
    expect(srt).toContain('hook line');
  }, 120_000);

  it('rejects non-video input by file signature (not extension)', async () => {
    const fake = path.join(workDir, 'fake.mp4');
    await writeFile(fake, 'this is plain text pretending to be mp4');
    const svc = new RenderService();
    await expect(
      svc.render({
        sourcePath: fake,
        candidate: { startS: 0, endS: 2 },
        workDir,
        outPath: path.join(workDir, 'nope.mp4'),
      }),
    ).rejects.toThrow(/signature/i);
  });

  it('renders without subtitles when burnSubtitles=false and no cues provided', async () => {
    const svc = new RenderService();
    const out = path.join(workDir, 'clip-no-subs.mp4');
    const r = await svc.render({
      sourcePath: SAMPLE,
      candidate: { startS: 0, endS: 4 },
      aspectRatio: '9:16',
      targetHeight: 1280,
      workDir,
      outPath: out,
    });
    expect(r.width).toBe(720);
    expect(r.height).toBe(1280);
    expect(r.srtPath).toBeUndefined();
  }, 60_000);
});

async function mkdtempSafe(): Promise<string> {
  const d = path.join(os.tmpdir(), `clipforge-render-test-${Date.now()}`);
  await mkdir(d, { recursive: true });
  return d;
}
