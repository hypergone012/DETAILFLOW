import Anthropic from '@anthropic-ai/sdk'

/**
 * Server-side LLM adapter. The assistant core speaks the Messages API shape;
 * a provider plugs in by implementing `createMessage`. Nothing here can touch
 * the database: tools are executed by the core, never by the adapter.
 */
export interface LlmRequest {
  system: string
  tools: Anthropic.Beta.BetaTool[]
  messages: Anthropic.Beta.BetaMessageParam[]
}

export interface LlmAdapter {
  readonly model: string
  createMessage(req: LlmRequest): Promise<Anthropic.Beta.BetaMessage>
}

export interface AnthropicAdapterConfig {
  apiKey: string
  model: string
  effort: 'low' | 'medium' | 'high'
  timeoutMs?: number
}

export function createAnthropicAdapter(cfg: AnthropicAdapterConfig): LlmAdapter {
  const client = new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs ?? 25_000, maxRetries: 1 })
  return {
    model: cfg.model,
    createMessage: (req) =>
      client.beta.messages.create({
        model: cfg.model,
        max_tokens: 4096,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        // Concierge chat: low effort keeps latency and cost down; adaptive thinking is the model default.
        output_config: { effort: cfg.effort },
        cache_control: { type: 'ephemeral' },
        // If the model declines on policy grounds, the API retries on its default fallback.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }),
  }
}
