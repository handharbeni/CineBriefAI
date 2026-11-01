// FFprobeService — real media inspection. NO MOCK DATA: every field is read
// from ffprobe output on the actual file. Accepts a local path or an http(s)
// URL (URLs are fetched to a temp file first, with SSRF validation — we never
// hand unvalidated remote URLs to ffmpeg directly).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { assertSafeUrl, safeDownload } from '@clipforge/media';

const pexec = promisify(execFile);

/** Strongly-typed metadata contract for probed media. */
export interface MediaMetadata {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  /** total bitrate in bits/s (container-level; falls back to stream sum) */
  bitrateBps: number;
  hasAudio: boolean;
  sizeBytes: number;
  formatName: string;
}

export interface FFprobeSource {
  /** local absolute path OR validated http(s) URL */
  pathOrUrl: string;
}

export class FFprobeService {
  /**
   * Probe a media source. For URLs, downloads to a temp file first
   * (SSRF-validated) so ffmpeg input paths are always files we control.
   */
  async probe(src: FFprobeSource): Promise<MediaMetadata> {
    if (/^https?:\/\//i.test(src.pathOrUrl)) {
      // SSRF: scheme allow-list + DNS pre-resolution rejecting private/link-local ranges.
      await assertSafeUrl(src.pathOrUrl);
      const dir = await mkdtemp(`${tmpdir()}/clipforge-probe-`);
      try {
        const dest = `${dir}/input.bin`;
        // safeDownload re-validates redirects and caps size/time.
        await safeDownload(src.pathOrUrl, dest, { maxBytes: 2 * 1024 * 1024 * 1024, timeoutMs: 120_000 });
        return await this.probeLocal(dest);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    return this.probeLocal(src.pathOrUrl);
  }

  async probeLocal(path: string): Promise<MediaMetadata> {
    const { stdout } = await pexec(
      'ffprobe',
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        path,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    let j: any;
    try {
      j = JSON.parse(stdout);
    } catch {
      throw new Error(`ffprobe returned unparsable output for ${path}`);
    }
    const streams: any[] = j.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    if (!v) throw new Error(`No video stream found in ${path}`);

    const parseRational = (s: unknown): number => {
      if (typeof s === 'number') return s;
      if (typeof s === 'string' && s.includes('/')) {
        const [n, d] = s.split('/').map(Number);
        return d ? n / d : 0;
      }
      const f = parseFloat(String(s));
      return Number.isFinite(f) ? f : 0;
    };

    const fps = parseRational(v.avg_frame_rate ?? v.r_frame_rate);
    const containerBitrate = parseInt(j.format?.bit_rate ?? '0', 10);
    const streamBitrateSum = streams.reduce(
      (acc: number, s: any) => acc + (parseInt(s.bit_rate ?? '0', 10) || 0),
      0,
    );
    const durationS = parseRational(j.format?.duration ?? v.duration);

    return {
      durationS,
      width: Number(v.width),
      height: Number(v.height),
      fps,
      videoCodec: String(v.codec_name ?? ''),
      audioCodec: a ? String(a.codec_name) : null,
      bitrateBps: containerBitrate || streamBitrateSum,
      hasAudio: !!a,
      sizeBytes: parseInt(j.format?.size ?? '0', 10),
      formatName: String(j.format?.format_name ?? ''),
    };
  }
}
