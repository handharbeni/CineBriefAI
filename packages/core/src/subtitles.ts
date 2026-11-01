// Subtitle engine: word-level timing model with editable text, SRT + ASS export,
// and an FFmpeg burn-in filter builder. Pure functions — unit tested.
import { z } from 'zod';

export const WordSchema = z.object({
  text: z.string().min(1),
  startS: z.number().min(0),
  endS: z.number().nonnegative(),
});
export type Word = z.infer<typeof WordSchema>;

export const CueSchema = z.object({
  id: z.string(),
  words: z.array(WordSchema).min(1),
  style: z.enum(['default', 'emphasis', 'cta']).default('default'),
});
export type Cue = z.infer<typeof CueSchema>;

export const SubtitleDocSchema = z.object({
  cues: z.array(CueSchema),
  highlightMode: z.enum(['none', 'word']).default('word'), // karaoke word highlighting
  fontSize: z.number().int().min(8).max(200).default(42),
  fontColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFD400'),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#000000'),
  marginV: z.number().int().min(0).max(1000).default(120),
});
export type SubtitleDoc = z.infer<typeof SubtitleDocSchema>;

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function srtTime(t: number): string {
  const ms = Math.round((t % 1) * 1000);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function assTime(t: number): string {
  const cs = Math.round((t % 1) * 100);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

const hexToAss = (hex: string) => `&H00${hex.slice(1, 3)}${hex.slice(5, 7)}${hex.slice(3, 5)}`.toUpperCase();

export function toSRT(doc: SubtitleDoc): string {
  const lines: string[] = [];
  doc.cues.forEach((cue, i) => {
    const start = Math.min(...cue.words.map((w) => w.startS));
    const end = Math.max(...cue.words.map((w) => w.endS));
    lines.push(String(i + 1));
    lines.push(`${srtTime(start)} --> ${srtTime(end)}`);
    lines.push(cue.words.map((w) => w.text).join(' '));
    lines.push('');
  });
  return lines.join('\n').trimEnd() + '\n';
}

/** ASS with per-word karaoke highlights (\k) when highlightMode === 'word'. */
export function toASS(doc: SubtitleDoc, playResX = 1080, playResY = 1920): string {
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${doc.fontSize},${hexToAss(doc.fontColor)},${hexToAss(doc.highlightColor)},${hexToAss(doc.outlineColor)},&H00000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,${doc.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = doc.cues.map((cue) => {
    const start = Math.min(...cue.words.map((w) => w.startS));
    const end = Math.max(...cue.words.map((w) => w.endS));
    let text: string;
    if (doc.highlightMode === 'word') {
      text = cue.words
        .map((w) => {
          const durCs = Math.max(1, Math.round((w.endS - w.startS) * 100));
          return `{\\k${durCs}}${w.text}`;
        })
        .join(' ');
    } else {
      text = cue.words.map((w) => w.text).join(' ');
    }
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;
  });
  return [...head, ...events].join('\n') + '\n';
}

/** Group flat words into cues by max duration / word count (for STT output without cues). */
export function groupWordsIntoCues(words: Word[], maxDurS = 3.5, maxWords = 8): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) {
      cues.push({ id: `cue-${cues.length}`, words: cur, style: 'default' });
      cur = [];
    }
  };
  for (const w of words) {
    if (cur.length === 0) { cur.push(w); continue; }
    const dur = w.endS - cur[0].startS;
    if (dur > maxDurS || cur.length >= maxWords) { flush(); cur.push(w); }
    else cur.push(w);
  }
  flush();
  return cues;
}

/** Build ffmpeg subtitle filter args (safe: paths passed as array args, never shell strings). */
export function burnInFilter(assPath: string): { filter: string; isAss: boolean } {
  const escaped = assPath.replace(/\\/g, '\\\\\\\\').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'");
  return { filter: `subtitles='${escaped}'`, isAss: true };
}
