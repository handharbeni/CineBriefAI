// File signature (magic byte) validation — never trust client MIME/extension.
import { open } from 'node:fs/promises';

export type MediaKind = 'mp4' | 'mov' | 'webm' | 'mkv' | 'mp3' | 'wav' | 'ogg' | 'jpg' | 'png' | 'gif' | 'webp' | 'txt' | 'unknown';

const SIGS: { ext: MediaKind; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'mp4', test: (b) => b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 }, // ....ftyp
  { ext: 'mov', test: (b) => b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && (b[8] === 0x71 || b[8] === 0x51) }, // ftypqt
  { ext: 'webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { ext: 'mkv', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { ext: 'mp3', test: (b) => (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || (b.length > 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) },
  { ext: 'wav', test: (b) => b.length > 11 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE' },
  { ext: 'ogg', test: (b) => b.length > 4 && b.subarray(0, 4).toString() === 'OggS' },
  { ext: 'jpg', test: (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'gif', test: (b) => b.length > 6 && b.subarray(0, 6).toString().startsWith('GIF8') },
  { ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];

export async function detectFileKind(path: string): Promise<MediaKind> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    const b = new Uint8Array(buf.subarray(0, bytesRead));
    for (const s of SIGS) if (s.test(b)) return s.ext;
    // crude text check for transcripts/srt
    if ([...b].every((c) => c === 0x0a || c === 0x0d || c === 0x09 || (c >= 0x20 && c < 0x7f))) return 'txt';
    return 'unknown';
  } finally {
    await fh.close();
  }
}

export const ALLOWED_VIDEO_KINDS: MediaKind[] = ['mp4', 'mov', 'webm', 'mkv'];
export const ALLOWED_AUDIO_KINDS: MediaKind[] = ['mp3', 'wav', 'ogg'];
export const ALLOWED_IMAGE_KINDS: MediaKind[] = ['jpg', 'png', 'gif', 'webp'];
