// Transcription adapters implementing the SttProvider interface from @clipforge/core.
// NO fake transcripts: every result comes from a real provider call. When a
// provider is unconfigured, construction throws ProviderNotConfiguredError.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SttProvider, SttResult, SttSegment, SttWord } from '@clipforge/core';

const pexec = promisify(execFile);

/** Normalized transcript segment contract (per task spec). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: SttWord[];
}

export interface TranscriptionProvider extends SttProvider {
  transcribeFile(audioOrVideoPath: string, lang?: string): Promise<{ segments: TranscriptSegment[]; language: string }>;
}

// ─── OpenAI Whisper HTTP adapter (real API calls via fetch) ────────────────

export interface WhisperConfig {
  apiKey: string;
  baseUrl?: string; // default https://api.openai.com/v1 — override for Azure/proxies
  model?: string;   // whisper-1 | gpt-4o-transcribe
}

export class OpenAIWhisperProvider implements TranscriptionProvider {
  readonly id = 'openai-whisper';
  readonly model: string;
  private cfg: WhisperConfig;

  constructor(cfg: WhisperConfig) {
    if (!cfg.apiKey) throw new Error('OpenAIWhisperProvider: OPENAI_API_KEY missing — refusing to run without a real key');
    this.cfg = cfg;
    this.model = cfg.model ?? 'whisper-1';
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIWhisperProvider {
    const key = env.OPENAI_API_KEY ?? '';
    if (!key) throw new Error('OPENAI_API_KEY is not set. See docs/providers.md — we never fake STT output.');
    return new OpenAIWhisperProvider({ apiKey: key, baseUrl: env.OPENAI_BASE_URL, model: env.WHISPER_MODEL });
  }

  /** Extract mono 16k wav first — Whisper accepts mp4 but audio extraction is cheaper & deterministic. */
  private async prepareAudio(path: string, workDir: string): Promise<string> {
    const wav = `${workDir}/audio-${randomUUID().slice(0, 8)}.wav`;
    await pexec('ffmpeg', ['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return wav;
  }

  async transcribeFile(path: string, lang?: string): Promise<{ segments: TranscriptSegment[]; language: string }> {
    const dir = await mkdtemp(`${tmpdir()}/clipforge-stt-`);
    try {
      const wav = await this.prepareAudio(path, dir);
      const form = new FormData();
      form.append('file', new Blob([await readFile(wav)], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', this.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
      if (lang) form.append('language', lang);

      const base = this.cfg.baseUrl ?? 'https://api.openai.com/v1';
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
        body: form as any,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Whisper API ${res.status}: ${body.slice(0, 500)}`);
      }
      const json: any = await res.json();
      const segments: TranscriptSegment[] = (json.segments ?? []).map((s: any) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: String(s.text).trim(),
        words: Array.isArray(s.words)
          ? s.words.map((w: any) => ({ text: String(w.word).trim(), startS: Number(w.start), endS: Number(w.end) }))
          : undefined,
      }));
      if (!segments.length && typeof json.text === 'string' && json.text.trim()) {
        // Providers like gpt-4o-transcribe may return plain text; keep honest single segment spanning file.
        segments.push({ start: 0, end: 0, text: json.text.trim() });
      }
      return { segments, language: json.language ?? lang ?? 'unknown' };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async transcribe(audioPath: string, lang?: string): Promise<SttResult> {
    const { segments, language } = await this.transcribeFile(audioPath, lang);
    return {
      language,
      provider: this.id,
      model: this.model,
      segments: segments.map((s) => ({ text: s.text, start: s.start, end: s.end, words: s.words })),
    };
  }
}

// ─── Local whisper.cpp CLI adapter (fully offline, real transcription) ─────

export interface WhisperCppConfig {
  binary: string; // path to whisper-cli / main
  modelPath: string; // ggml model file
  model?: string; // display name override (defaults to modelPath)
  threads?: number;
  language?: string;
}

export class WhisperCppProvider implements TranscriptionProvider {
  readonly id = 'whisper-cpp';
  readonly model: string;
  private cfg: WhisperCppConfig;

  constructor(cfg: WhisperCppConfig) {
    if (!cfg.binary || !cfg.modelPath) {
      throw new Error('WhisperCppProvider requires WHISPER_CPP_BIN and WHISPER_CPP_MODEL paths');
    }
    this.cfg = cfg;
    this.model = cfg.modelPath;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WhisperCppProvider {
    const bin = env.WHISPER_CPP_BIN ?? '';
    const model = env.WHISPER_CPP_MODEL ?? '';
    if (!bin || !model) throw new Error('WHISPER_CPP_BIN / WHISPER_CPP_MODEL not set. See docs/providers.md');
    return new WhisperCppProvider({ binary: bin, modelPath: model, threads: Number(env.WHISPER_CPP_THREADS ?? 4) });
  }

  async transcribeFile(path: string, lang?: string): Promise<{ segments: TranscriptSegment[]; language: string }> {
    const dir = await mkdtemp(`${tmpdir()}/clipforge-stt-`);
    try {
      const wav = `${dir}/in.wav`;
      await pexec('ffmpeg', ['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      const outJson = `${dir}/out.json`;
      await pexec(
        this.cfg.binary,
        [
          '-m', this.cfg.modelPath,
          '-f', wav,
          '-oj', // whisper.cpp JSON segments output
          '-of', outJson,
          '-l', lang ?? this.cfg.language ?? 'auto',
          '-t', String(this.cfg.threads ?? 4),
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const j: any = JSON.parse(await readFile(outJson, 'utf8'));
      const segs: TranscriptSegment[] = (j.transcription ?? []).map((s: any) => ({
        start: Number(s.offsets?.from ?? 0) / 1000,
        end: Number(s.offsets?.to ?? 0) / 1000,
        text: String(s.text ?? '').trim(),
      }));
      return { segments: segs, language: lang ?? this.cfg.language ?? 'auto' };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async transcribe(audioPath: string, lang?: string): Promise<SttResult> {
    const { segments, language } = await this.transcribeFile(audioPath, lang);
    return {
      language,
      provider: this.id,
      model: this.model,
      segments: segments.map((s) => ({ text: s.text, start: s.start, end: s.end, words: s.words })),
    };
  }
}

// ─── Registry: explicit selection, loud failure when unconfigured ──────────

export function createSttProviderFromEnv(env: NodeJS.ProcessEnv = process.env): TranscriptionProvider {
  const which = (env.STT_PROVIDER ?? 'openai').toLowerCase();
  if (which === 'openai') return OpenAIWhisperProvider.fromEnv(env);
  if (which === 'whisper-cpp' || which === 'local') return WhisperCppProvider.fromEnv(env);
  throw new Error(`Unknown STT_PROVIDER "${which}" (expected openai | whisper-cpp)`);
}
