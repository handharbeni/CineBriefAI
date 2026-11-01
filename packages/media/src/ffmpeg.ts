// FFmpeg/FFprobe wrappers. SECURITY: all arguments are passed as arrays via
// execFile (never shell strings), so user input can never inject commands.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const pexec = promisify(execFile);

export interface MediaMeta {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec?: string;
  sizeBytes: number;
}

export async function ffprobe(path: string): Promise<MediaMeta> {
  const { stdout } = await pexec('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
  const a = (j.streams || []).find((s: any) => s.codec_type === 'audio');
  if (!v) throw new Error(`No video stream found in ${path}`);
  const fpsStr: string = v.avg_frame_rate || '0/1';
  const [num, den] = fpsStr.split('/').map(Number);
  return {
    durationS: parseFloat(j.format?.duration ?? v.duration ?? '0'),
    width: v.width,
    height: v.height,
    fps: den ? num / den : 0,
    hasAudio: !!a,
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name,
    sizeBytes: parseInt(j.format?.size ?? '0', 10),
  };
}

/**
 * Scene-change detection using the select+showinfo filters. Returns boundary times (s).
 * `threshold` is on a 0-100 scale (PySceneDetect-compatible). ffmpeg scene scores are
 * in [0,1], so we map via threshold/100 and clamp to (0.001, 0.999) to keep the
 * comparison meaningful (a raw threshold of 100 would demand score > 1 → never true).
 */
export async function detectScenes(path: string, threshold = 5, maxScenes = 200): Promise<number[]> {
  const score = Math.min(0.999, Math.max(0.001, threshold / 100));
  const { stderr } = await pexec(
    'ffmpeg',
    ['-v', 'info', '-i', path, '-filter:v', `select='gt(scene,${score})',showinfo`, '-f', 'null', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const times: number[] = [];
  for (const m of stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
    const t = parseFloat(m[1]);
    if (t > 0.1) times.push(Math.round(t * 1000) / 1000);
    if (times.length >= maxScenes) break;
  }
  return [...new Set(times)].sort((x, y) => x - y);
}

/** Extract frames at given timestamps to outDir; returns file paths. Uses real decode, no fakes. */
export async function extractFrames(path: string, timesS: number[], outDir: string, maxWidth = 640): Promise<string[]> {
  const out: string[] = [];
  for (const t of timesS.slice(0, 60)) {
    const f = `${outDir}/frame-${t.toFixed(2)}-${randomUUID().slice(0, 8)}.jpg`;
    await pexec('ffmpeg', [
      '-y', '-ss', String(t), '-i', path,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-q:v', '3',
      f,
    ]);
    out.push(f);
  }
  return out;
}

export interface ClipOptions {
  startS: number;
  endS: number;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  burnSubtitlesAss?: string; // absolute path to .ass file
  audioPath?: string;        // replace/mix voice-over track
  targetHeight?: number;     // e.g. 1920
}

/** Center-crop + scale to aspect ratio, accurate seek, re-encode with libx264/aac. */
export async function renderClip(srcPath: string, outPath: string, opts: ClipOptions): Promise<void> {
  const dur = opts.endS - opts.startS;
  if (!(dur > 0)) throw new Error(`Invalid clip window ${opts.startS}-${opts.endS}`);
  const filters: string[] = [];
  if (opts.aspectRatio) {
    const [arW, arH] = opts.aspectRatio.split(':').map(Number);
    const h = opts.targetHeight ?? 1280;
    const w = Math.round((h * arW) / arH / 2) * 2;
    // Center-crop source to target aspect ratio using the standard ffmpeg idiom:
    // out_w = min(iw, ih*AR), out_h = min(ih, iw/AR)
    filters.push(
      `crop='min(iw\\,ih*${arW}/${arH})':'min(ih\\,iw*${arH}/${arW})'`,
    );
    filters.push(`scale=${w}:${h}`);
  } else if (opts.targetHeight) {
    filters.push(`scale=-2:${opts.targetHeight}`);
  }
  if (opts.burnSubtitlesAss) {
    const esc = opts.burnSubtitlesAss.replace(/\\/g, '\\\\\\\\').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'");
    filters.push(`subtitles='${esc}'`);
  }
  const args = ['-y', '-ss', String(opts.startS), '-i', srcPath, '-t', String(dur)];
  if (opts.audioPath) args.push('-i', opts.audioPath, '-map', '0:v:0', '-map', '1:a:0', '-shortest');
  if (filters.length) args.push('-vf', filters.join(','));
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-c:a', opts.audioPath ? 'aac' : 'copy',
    '-movflags', '+faststart',
    outPath,
  );
  await pexec('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
}

/** Export SRT sidecar + optional ASS for preview overlays. */
export async function exportSubtitleFiles(assContent: string, srtContent: string, outDir: string): Promise<{ ass: string; srt: string }> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(outDir, { recursive: true });
  const ass = `${outDir}/subs.ass`;
  const srt = `${outDir}/subs.srt`;
  await writeFile(ass, assContent);
  await writeFile(srt, srtContent);
  return { ass, srt };
}

/** Concatenate segments (same codec settings assumed) via concat demuxer. Used by Mode B assembly. */
export async function concatSegments(segmentPaths: string[], outPath: string, workDir: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const listFile = `${workDir}/concat-${randomUUID()}.txt`;
  const body = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await writeFile(listFile, body);
  await pexec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);
}
