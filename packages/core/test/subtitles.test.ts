import { describe, it, expect } from 'vitest';
import { toSRT, toASS, groupWordsIntoCues, srtTime, SubtitleDocSchema } from '../src/subtitles';

const words = [
  { text: 'Hello', startS: 0.0, endS: 0.4 },
  { text: 'world', startS: 0.4, endS: 0.9 },
  { text: 'this', startS: 1.2, endS: 1.5 },
  { text: 'is', startS: 1.5, endS: 1.7 },
  { text: 'a', startS: 1.7, endS: 1.8 },
  { text: 'test', startS: 1.8, endS: 2.3 },
];

describe('subtitle engine', () => {
  it('formats srt timestamps', () => {
    expect(srtTime(3661.5)).toBe('01:01:01,500');
  });
  it('groups words into cues bounded by duration/word count', () => {
    const cues = groupWordsIntoCues(words, 1.5, 4);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].words[0].text).toBe('Hello');
  });
  it('exports valid SRT', () => {
    const doc = SubtitleDocSchema.parse({ cues: groupWordsIntoCues(words) });
    const srt = toSRT(doc);
    expect(srt).toContain('-->');
    expect(srt.split('\n\n')[0]).toContain('Hello world');
  });
  it('exports ASS with karaoke \\k tags per word', () => {
    const doc = SubtitleDocSchema.parse({ cues: groupWordsIntoCues(words), highlightMode: 'word' });
    const ass = toASS(doc);
    expect(ass).toContain('{\\k40}Hello');
    expect(ass).toContain('[Events]');
  });
});
