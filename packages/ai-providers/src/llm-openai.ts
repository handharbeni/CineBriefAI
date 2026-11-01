// OpenAI-compatible LLM adapter (works with OpenAI, Azure, Ollama /v1, any proxy).
// Real HTTP calls only. Used for semantic candidate scoring & compliance review.
import type { LlmProvider, LlmMessage, LlmResult } from '@clipforge/core';

export interface LlmConfig {
  apiKey: string;
  baseUrl?: string; // default https://api.openai.com/v1
  model?: string;
}

export class OpenAICompatibleLlmProvider implements LlmProvider {
  readonly id = 'openai-compatible-llm';
  readonly model: string;
  private cfg: LlmConfig;

  constructor(cfg: LlmConfig) {
    if (!cfg.apiKey) throw new Error('LLM provider requires an apiKey (OPENAI_API_KEY or LLM_API_KEY). No fake completions.');
    this.cfg = cfg;
    this.model = cfg.model ?? 'gpt-4o-mini';
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleLlmProvider {
    const key = env.LLM_API_KEY || env.OPENAI_API_KEY || '';
    if (!key) throw new Error('LLM_API_KEY/OPENAI_API_KEY not set. See docs/providers.md');
    return new OpenAICompatibleLlmProvider({
      apiKey: key,
      baseUrl: env.LLM_BASE_URL ?? env.OPENAI_BASE_URL,
      model: env.LLM_MODEL ?? 'gpt-4o-mini',
    });
  }

  async complete(msgs: LlmMessage[], opts?: { json?: boolean; maxTokens?: number }): Promise<LlmResult> {
    const base = this.cfg.baseUrl ?? 'https://api.openai.com/v1';
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: msgs,
        max_tokens: opts?.maxTokens ?? 2048,
        ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 400)}`);
    const j: any = await res.json();
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('LLM returned no content');
    return {
      text,
      provider: this.id,
      model: this.model,
      usage: j.usage
        ? { promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens }
        : undefined,
    };
  }
}
