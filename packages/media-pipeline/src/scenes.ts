// Scene detection + segmentation. Builds Scene objects {startTime,endTime,thumbnailPath}
// from real ffmpeg scene scores and extracts real keyframes via @clipforge/media.
import { mkdir } from 'node:fs/promises';
import { detectScenes, extractFrames } from '@clipforge/media';

export interface Scene {
  startTime: number;
  endTime: number;
  thumbnailPath: string;
  /** peak scene-change score entering this scene (0..1), if known */
  score?: number;
}

/**
 * Detect scenes and produce segments covering [0, duration].
 * `threshold` is 0..1 passed straight to ffmpeg's gt(scene,X) filter.
 */
export async function detectSceneSegments(
  path: string,
  durationS: number,
  opts: { threshold?: number; thumbDir: string; maxScenes?: number } = {
    thumbDir: '.',
  },
): Promise<Scene[]> {
  const threshold = opts.threshold ?? 0.3;
  if (!(threshold > 0 && threshold < 1)) {
    throw new Error(`scene threshold must be in (0,1), got ${threshold}`);
  }
  await mkdir(opts.thumbDir, { recursive: true });

  // detectScenes in @clipforge/media takes a 0-100 scale internally mapped by /100.
  const boundaries = await detectScenes(path, Math.round(threshold * 100), opts.maxScenes ?? 200);

  const starts = [0, ...boundaries.filter((t) => t < durationS - 0.05)];
  const ends = [...starts.slice(1), durationS];
  const prelim: Omit<Scene, 'thumbnailPath'>[] = starts.map((s, i) => ({
    startTime: Math.round(s * 1000) / 1000,
    endTime: Math.round(ends[i] * 1000) / 1000,
  }));

  // Real keyframe extraction at each scene start (midpoint fallback for tiny scenes)
  const times = prelim.map((sc) =>
    sc.endTime - sc.startTime >= 0.5 ? sc.startTime + 0.25 : (sc.startTime + sc.endTime) / 2,
  );
  const thumbs = await extractFrames(path, times, opts.thumbDir);

  return prelim.map((sc, i) => ({ ...sc, thumbnailPath: thumbs[i] ?? '' }));
}
