import type { LoggingConfig } from './config.js';
import type { AnthropicRequest, AnthropicContentBlock } from './types.js';

let config: LoggingConfig = { level: 'standard' };

export function initLogger(cfg: LoggingConfig) {
  config = cfg;
}

// ── Token Usage Type ──────────────────────────────

export interface TokenUsage {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: number;
}

// ── Colors ─────────────────────────────────────────

const c = {
  dim:     (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:    (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan:    (s: string) => `\x1b[36m${s}\x1b[0m`,
  green:   (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:  (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:     (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  blue:    (s: string) => `\x1b[34m${s}\x1b[0m`,
};

function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s: string, max: number): string {
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function formatUsage(usage?: TokenUsage): string {
  if (!usage) return '';

  // Line 1: token counts
  const parts: string[] = [];
  parts.push(`${usage.input}in`);
  if (usage.cached) parts.push(`${c.green(String(usage.cached))}cached`);
  if (usage.cacheWrite) parts.push(`${usage.cacheWrite}write`);
  parts.push(`${usage.output}out`);
  if (usage.reasoning) parts.push(`${usage.reasoning}reason`);

  let str = `  ${c.dim(parts.join(' · '))}`;

  // Cost
  if (usage.cost !== undefined) {
    str += `  ${c.yellow('$' + usage.cost.toFixed(4))}`;
  }

  return str;
}

// ── Content helpers ────────────────────────────────

function lastUserMessage(req: AnthropicRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    const text = msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join(' ');
    if (text) return text;
    const toolResults = msg.content.filter(b => b.type === 'tool_result').length;
    if (toolResults) return `[${toolResults} tool result(s)]`;
  }
  return '(empty)';
}

function extractResponseText(content?: AnthropicContentBlock[]): string {
  if (!content) return '';
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join(' ');
}

function extractToolNames(content?: AnthropicContentBlock[]): string[] {
  if (!content) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => b.name ?? '?');
}

// ── Public API ─────────────────────────────────────

export function logRequest(req: AnthropicRequest, backendName: string) {
  const turns = req.messages.filter(m => m.role === 'user').length;
  const tools = req.tools?.length ?? 0;
  const mode = req.stream ? 'stream' : 'sync';
  const input = truncate(lastUserMessage(req), 80);

  const meta = [
    `t${turns}`,
    `${req.max_tokens}tok`,
    tools > 0 ? `${tools}tools` : null,
    mode,
  ].filter(Boolean).join(' · ');

  console.log('');
  console.log(`${c.dim(timestamp())}  ${c.cyan(c.bold(req.model))} → ${c.magenta(backendName)}  ${c.dim(meta)}`);
  console.log(`  ${c.blue('▶')} ${input}`);
}

export function logResponseSync(
  _model: string,
  _backendName: string,
  status: number,
  durationMs: number,
  content?: AnthropicContentBlock[],
  usage?: TokenUsage,
) {
  const statusStr = status >= 200 && status < 300 ? c.green(`${status}`) : c.red(`${status}`);
  const text = truncate(extractResponseText(content), 120);
  const tools = extractToolNames(content);

  if (text) console.log(`  ${c.green('◀')} ${text}`);
  if (tools.length) console.log(`  ${c.yellow('⚡')} ${tools.join(', ')}`);
  console.log(`  ${statusStr} ${c.dim(formatDuration(durationMs))}${formatUsage(usage)}`);
}

export function logStreamStart(_model: string, _backendName: string) {
  // nothing — header already printed by logRequest
}

export function logStreamResponse(
  _model: string,
  _backendName: string,
  durationMs: number,
  text: string,
  toolCalls: Map<number, { name: string; args: string }>,
  usage?: TokenUsage,
) {
  if (text) console.log(`  ${c.green('◀')} ${truncate(text, 120)}`);
  if (toolCalls.size > 0) {
    const names = [...toolCalls.values()].map(t => t.name).join(', ');
    console.log(`  ${c.yellow('⚡')} ${names}`);
  }
  console.log(`  ${c.green('200')} ${c.dim(formatDuration(durationMs))}${formatUsage(usage)}`);
}

export function logResponseError(
  _model: string,
  _backendName: string,
  status: number,
  message: string,
) {
  console.log(`  ${c.red(`${status}`)} ${truncate(message, 120)}`);
}

export function logError(_model: string, _backendName: string, err: Error) {
  console.log(`  ${c.red('ERR')} ${err.message}`);
}
