// The Claude call for /api/reel, isolated: one structured-output request on the official SDK, and the one repair turn
// that continues the same conversation. The key comes from the function's environment (ANTHROPIC_API_KEY), never the
// client. Any answer other than a finished one (a refusal, a cut-off, an API error, a timeout) is a BackendError, and
// the reel function moves on to the next backend.
//
// Speed: Claude Opus 5.5 runs in fast mode (`speed: "fast"`, no beta header on this model) unless REEL_FAST=0. A fast
// call that fails quickly for a reason other than a timeout or an abort (fast capacity or rate limit, an overloaded or
// failing server, a refused speed, a dropped connection) is tried ONCE more at standard speed when at least
// RETRY_MIN_MS of the budget is left. Requests at different speeds do not share prompt-cache entries, so the warm-up
// below uses the same speed as the reels.
import Anthropic from '@anthropic-ai/sdk';
import { type Attempt, type Backend, BackendError, bounded, type CallOpts, monoNow, reelSchema, systemPrompt, type Usage } from './reel-core.js';

export const DEFAULT_REEL_MODEL = 'claude-opus-5-5';

/** REEL_MODEL may name a cheaper model; it must take `output_config.effort` and structured outputs. */
export const reelModel = (): string => process.env.REEL_MODEL?.trim() || DEFAULT_REEL_MODEL;

/** The models fast mode is used on (no beta header needed for these). */
const FAST_MODELS = new Set(['claude-opus-5-5']);

/** Fast mode: on for Claude Opus 5.5 unless the environment says REEL_FAST=0. */
export const reelFast = (model: string = reelModel()): boolean => FAST_MODELS.has(model) && process.env.REEL_FAST?.trim() !== '0';

/** A failed fast call is retried at standard speed only with at least this much of the budget left. */
export const RETRY_MIN_MS = 5000;

/** Models that take server-side `fallbacks` (a refusal is re-run on Anthropic's recommended model for its category). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5']);

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Speed = 'fast' | 'standard';

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
  if (err instanceof Anthropic.APIConnectionError) {
    // the SDK's message is only "Connection error.": what went wrong is in its cause
    const cause = (err as { cause?: unknown }).cause;
    const why = cause instanceof Error ? `${cause.name}: ${cause.message}` : cause ? String(cause) : '';
    return new BackendError('network', why ? `${err.message} (${why.slice(0, 160)})` : err.message);
  }
  if (err instanceof Anthropic.RateLimitError) return new BackendError('rate_limit', 'rate limited (429)');
  if (err instanceof Anthropic.AuthenticationError) return new BackendError('auth', 'the API key was refused (401)');
  if (err instanceof Anthropic.PermissionDeniedError) return new BackendError('auth', 'not allowed for this key (403)');
  if (err instanceof Anthropic.NotFoundError) return new BackendError('not_found', `model not found (404): ${reelModel()}`);
  if (err instanceof Anthropic.BadRequestError) return new BackendError('bad_request', `bad request (400): ${err.message}`);
  if (err instanceof Anthropic.InternalServerError) return new BackendError('server', `server error (${err.status})`);
  if (err instanceof Anthropic.APIError) return new BackendError('api', `API error ${err.status ?? ''}: ${err.message}`);
  return new BackendError('api', err instanceof Error ? err.message : String(err));
}

/**
 * Whether a failed FAST call may be worth one more try at standard speed: a quick failure that is about capacity,
 * permission or the speed itself, never a timeout, an abort, a bad key, a missing model or an unrelated bad request.
 */
export function speedRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.PermissionDeniedError) return true;
  if (err instanceof Anthropic.BadRequestError) return /speed|fast/i.test(err.message);
  if (err instanceof Anthropic.APIError) return (err.status ?? 0) >= 500;
  return false;
}

/** The request every reel call (and the warm-up) makes: the same system prompt, schema, effort and speed. */
function reelParams(model: string, system: string, messages: MessageParam[], speed: Speed, maxTokens = 16000): CreateParams {
  return {
    model,
    max_tokens: maxTokens,
    // the long, stable system prompt is cached; the story and the pitch come after it in the user turn
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    // thinking is adaptive and always on for this model: effort is the depth control, kept low for latency
    output_config: { effort: 'low', format: { type: 'json_schema', schema: reelSchema() } },
    ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    // fast mode runs Opus 5.5 up to 2.5x faster at twice the price ($8 / $40 per MTok); REEL_FAST=0 turns it off
    ...(speed === 'fast' ? { speed: 'fast' as const } : {}),
  };
}

/** The reel Director on Claude. `create` is the SDK call (a fake in tests); the model and speed are read per request. */
export function claudeBackend(create: CreateMessage = sdkCreate): Backend {
  /** One call at one speed. SDK errors are thrown as they are (the caller decides about a retry); the rest typed. */
  const once = async (system: string, messages: MessageParam[], opts: CallOpts, speed: Speed): Promise<Attempt> => {
    const model = reelModel();
    // no SDK retries: the deadline is short, and the standard-speed retry and the next backend are the retries
    const res = await create(reelParams(model, system, messages, speed), { signal: opts.signal, timeout: opts.timeoutMs, maxRetries: 0 });
    const usage = usageOf(res);
    const answered: Speed = res.usage.speed ?? speed;
    const fellBack = (res.usage.iterations ?? []).some((it) => it.type === 'fallback_message');
    console.log('REEL claude usage', JSON.stringify({ model: res.model, speed: answered, stop: res.stop_reason, ...usage, fellBack }));
    if (res.stop_reason === 'refusal') throw new BackendError('refusal', `declined (${res.stop_details?.category ?? 'no category'})`);
    if (res.stop_reason === 'max_tokens') throw new BackendError('max_tokens', 'cut off at max_tokens');
    if (res.stop_reason !== 'end_turn') throw new BackendError('stop', `stopped: ${res.stop_reason}`);
    return {
      text: answerText(res.content),
      model: res.model,
      usage,
      speed: answered,
      // the repair continues this conversation at the speed that answered (its cache entry is there): the answer goes
      // back unchanged (thinking and fallback blocks included)
      repair: (feedback, o) => ask(system, [...messages, { role: 'assistant', content: res.content }, { role: 'user', content: feedback }], o, answered),
    };
  };

  const ask = async (system: string, messages: MessageParam[], opts: CallOpts, speed: Speed): Promise<Attempt> => {
    const started = monoNow();
    try {
      return await once(system, messages, opts, speed);
    } catch (err) {
      const left = Math.floor(opts.timeoutMs - (monoNow() - started));
      if (speed !== 'fast' || opts.signal.aborted || left < RETRY_MIN_MS || !speedRetryable(err)) throw failure(err);
      const why = failure(err);
      console.log('REEL claude fast call failed, once more at standard speed:', `${why.kind}: ${why.message}`);
      try {
        const a = await once(system, messages, { signal: opts.signal, timeoutMs: left }, 'standard');
        return { ...a, retried: `fast: ${why.kind}: ${why.message}` };
      } catch (err2) {
        throw failure(err2);
      }
    }
  };

  return { name: 'claude', first: (system, user, opts) => ask(system, [{ role: 'user', content: user }], opts, reelFast() ? 'fast' : 'standard') };
}

export interface WarmResult {
  model: string;
  speed: string;
  usage: Usage;
}

/**
 * Warm the reel path before a player's first reel: the same system prompt (with its cache breakpoint), the same answer
 * schema, effort and speed as a reel, a one-word user turn and a one-token answer. The schema's grammar is compiled and
 * the system prompt's cache entry written, so the next reel starts warm. (`max_tokens: 0`, the usual cache pre-warm,
 * is refused together with a structured-output format, and without the format the grammar would not compile.)
 */
export async function warmClaude(timeoutMs: number, create: CreateMessage = sdkCreate): Promise<WarmResult> {
  const model = reelModel();
  const speed: Speed = reelFast(model) ? 'fast' : 'standard';
  const params = reelParams(model, systemPrompt(), [{ role: 'user', content: 'warm-up' }], speed, 1);
  let res: Message;
  try {
    res = await bounded((o) => create(params, { signal: o.signal, timeout: o.timeoutMs, maxRetries: 0 }), timeoutMs);
  } catch (err) {
    throw failure(err);
  }
  const usage = usageOf(res);
  const answered = res.usage.speed ?? speed;
  console.log('REEL warm usage', JSON.stringify({ model: res.model, speed: answered, stop: res.stop_reason, ...usage }));
  return { model: res.model, speed: answered, usage };
}
