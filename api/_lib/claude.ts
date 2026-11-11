// The Claude call for /api/reel, isolated: one structured-output request on the official SDK, and the one repair turn
// that continues the same conversation. The key comes from the function's environment (ANTHROPIC_API_KEY), never the
// client. Any answer other than a finished one (a refusal, a cut-off, an API error, a timeout) is a BackendError, and
// the reel function moves on to the next backend.
import Anthropic from '@anthropic-ai/sdk';
import { type Attempt, type Backend, BackendError, type CallOpts, reelSchema, type Usage } from './reel-core.js';

export const DEFAULT_REEL_MODEL = 'claude-opus-5-5';

/** REEL_MODEL may name a cheaper model; it must take `output_config.effort` and structured outputs. */
export const reelModel = (): string => process.env.REEL_MODEL?.trim() || DEFAULT_REEL_MODEL;

/** Models that take server-side `fallbacks` (a refusal is re-run on Anthropic's recommended model for its category). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5']);

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The one SDK call this module makes; a test passes a fake. */
export type CreateMessage = (params: CreateParams, options: { signal: AbortSignal; timeout: number; maxRetries: number }) => Promise<Message>;

let client: Anthropic | null = null;

/** One client per warm instance; `new Anthropic()` reads ANTHROPIC_API_KEY from the environment. */
const sdkCreate: CreateMessage = (params, options) => {
  client ??= new Anthropic();
  return client.beta.messages.create(params, options);
};

/** The text of the final answer: the text blocks after the last fallback switch point (if a fallback model ran). */
function answerText(content: Message['content']): string {
  const lastSwitch = content.map((b) => b.type).lastIndexOf('fallback');
  return content
    .slice(lastSwitch + 1)
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('');
}

function usageOf(m: Message): Usage {
  return {
    input: m.usage.input_tokens,
    output: m.usage.output_tokens,
    cacheRead: m.usage.cache_read_input_tokens ?? 0,
    cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
  };
}

/** Map an SDK error to a failure kind, most specific class first. */
function failure(err: unknown): BackendError {
  if (err instanceof BackendError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new BackendError('aborted', 'the call was aborted at the deadline');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new BackendError('timeout', 'the API did not answer in time');
  if (err instanceof Anthropic.APIConnectionError) return new BackendError('network', err.message);
  if (err instanceof Anthropic.RateLimitError) return new BackendError('rate_limit', 'rate limited (429)');
  if (err instanceof Anthropic.AuthenticationError) return new BackendError('auth', 'the API key was refused (401)');
  if (err instanceof Anthropic.PermissionDeniedError) return new BackendError('auth', 'not allowed for this key (403)');
  if (err instanceof Anthropic.NotFoundError) return new BackendError('not_found', `model not found (404): ${reelModel()}`);
  if (err instanceof Anthropic.BadRequestError) return new BackendError('bad_request', `bad request (400): ${err.message}`);
  if (err instanceof Anthropic.InternalServerError) return new BackendError('server', `server error (${err.status})`);
  if (err instanceof Anthropic.APIError) return new BackendError('api', `API error ${err.status ?? ''}: ${err.message}`);
  return new BackendError('api', err instanceof Error ? err.message : String(err));
}

/** The reel Director on Claude. `create` is the SDK call (a fake in tests); the model is read per request. */
export function claudeBackend(create: CreateMessage = sdkCreate): Backend {
  const ask = async (system: string, messages: MessageParam[], opts: CallOpts): Promise<Attempt> => {
    const model = reelModel();
    const params: CreateParams = {
      model,
      max_tokens: 16000,
      // the long, stable system prompt is cached; the story and the pitch come after it in the user turn
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      // thinking is adaptive and always on for this model: effort is the depth control, kept low for latency
      output_config: { effort: 'low', format: { type: 'json_schema', schema: reelSchema() } },
      ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      // opt-in: fast mode runs Opus 5.5 up to 2.5x faster at twice the price ($8 / $40 per MTok); off unless REEL_FAST=1
      ...(process.env.REEL_FAST === '1' && model === 'claude-opus-5-5' ? { speed: 'fast' as const } : {}),
    };
    let res: Message;
    try {
      // no SDK retries: the deadline is short and the next backend is the retry
      res = await create(params, { signal: opts.signal, timeout: opts.timeoutMs, maxRetries: 0 });
    } catch (err) {
      throw failure(err);
    }
    const usage = usageOf(res);
    const fellBack = (res.usage.iterations ?? []).some((it) => it.type === 'fallback_message');
    console.log('REEL claude usage', JSON.stringify({ model: res.model, stop: res.stop_reason, ...usage, fellBack }));
    if (res.stop_reason === 'refusal') throw new BackendError('refusal', `declined (${res.stop_details?.category ?? 'no category'})`);
    if (res.stop_reason === 'max_tokens') throw new BackendError('max_tokens', 'cut off at max_tokens');
    if (res.stop_reason !== 'end_turn') throw new BackendError('stop', `stopped: ${res.stop_reason}`);
    const text = answerText(res.content);
    return {
      text,
      model: res.model,
      usage,
      // the repair continues this conversation: the answer goes back unchanged (thinking and fallback blocks included)
      repair: (feedback, o) => ask(system, [...messages, { role: 'assistant', content: res.content }, { role: 'user', content: feedback }], o),
    };
  };
  return { name: 'claude', first: (system, user, opts) => ask(system, [{ role: 'user', content: user }], opts) };
}
