// Provider abstraction layer — strict interfaces with NO vendor lock-in.
// Real adapters live in apps/worker/adapters/*; when unconfigured the registry
// throws explicitly (we never fake results).
export interface SttWord { text: string; startS: number; endS: number }
export interface SttSegment { text: string; start: number; end: number; words?: SttWord[] }
export interface SttResult { language: string; segments: SttSegment[]; provider: string; model: string }

export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string | LlmPart[] }
export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }; // file:// or storage URL from our own pipeline

export interface LlmResult { text: string; provider: string; model: string; usage?: { promptTokens: number; completionTokens: number } }

export interface VideoGenRequest {
  prompt: string;
  aspectRatio: '9:16' | '1:1' | '16:9';
  durationS: number;
  seedImagePath?: string;
}
export interface VideoGenResult { outputPath: string; provider: string; model: string }

export interface ImageGenRequest { prompt: string; width: number; height: number; outputPath: string }
export interface TtsRequest { text: string; voice: string; outputPath: string; language?: string }

export interface LlmProvider {
  readonly id: string;
  complete(msgs: LlmMessage[], opts?: { json?: boolean; maxTokens?: number }): Promise<LlmResult>;
}
export interface SttProvider { readonly id: string; transcribe(audioPath: string, lang?: string): Promise<SttResult>; }
export interface TtsProvider { readonly id: string; synthesize(req: TtsRequest): Promise<void>; }
export interface VideoGenProvider { readonly id: string; generate(req: VideoGenRequest): Promise<VideoGenResult>; }
export interface ImageGenProvider { readonly id: string; generate(req: ImageGenRequest): Promise<void>; }

export interface StorageProvider {
  readonly id: string;
  put(key: string, filePath: string, contentType?: string): Promise<string>; // returns public/signed URL
  get(key: string, destPath: string): Promise<void>;
  signedUrl(key: string, ttlS?: number): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`Provider "${provider}" is not configured. Set its env vars per README/providers.md — refusing to fake results.`);
    this.name = 'ProviderNotConfiguredError';
  }
}
