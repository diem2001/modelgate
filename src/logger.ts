import type { LoggingConfig } from './config.js';
import type { AnthropicRequest, AnthropicContentBlock, AnthropicMessage } from './types.js';

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
  if (max === 0 || s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function inputLimit(): number {
  if (config.level === 'verbose') return 0;
  if (config.level === 'minimal') return 0;
  return 80; // standard
}

function outputLimit(): number {
  if (config.level === 'verbose') return 0;
  if (config.level === 'minimal') return 0;
  return 120; // standard
}

function formatUsage(usage?: TokenUsage): string {
  if (!usage) return '';

  // Line 1: token counts
  const parts: string[] = [];
  parts.push(`${usage.input} in`);
  if (usage.cached) parts.push(`${c.green(String(usage.cached))} cached`);
  if (usage.cacheWrite) parts.push(`${usage.cacheWrite} write`);
  parts.push(`${usage.output} out`);
  if (usage.reasoning) parts.push(`${usage.reasoning} reason`);

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
    const toolResults = msg.content.filter(b => b.type === 'tool_result');
    if (toolResults.length) return formatToolResults(toolResults, req.messages, i);
  }
  return '(empty)';
}

function formatToolResults(
  results: AnthropicContentBlock[],
  messages: AnthropicMessage[],
  userMsgIndex: number,
): string {
  // Build map from tool_use_id → {name, input} from previous assistant message
  const toolUseMap = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (let j = userMsgIndex - 1; j >= 0; j--) {
    const prev = messages[j];
    if (prev.role !== 'assistant' || typeof prev.content === 'string') continue;
    for (const block of prev.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        toolUseMap.set(block.id, { name: block.name, input: (block.input as Record<string, unknown>) ?? {} });
      }
    }
    break; // only check the immediately preceding assistant message
  }

  const parts = results.map(r => {
    const toolUse = r.tool_use_id ? toolUseMap.get(r.tool_use_id) : undefined;
    const name = toolUse?.name ?? '?';
    const detail = toolInputSummary(name, toolUse?.input);
    const preview = toolResultPreview(r);
    return detail
      ? `${name}(${detail})${preview ? ' → ' + preview : ''}`
      : `${name}${preview ? ' → ' + preview : ''}`;
  });

  return parts.join(' · ');
}

function toolInputSummary(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (name) {
    case 'Read': {
      const fp = input.file_path as string | undefined;
      return fp ? basename(fp) : '';
    }
    case 'Edit':
    case 'Write': {
      const fp = input.file_path as string | undefined;
      return fp ? basename(fp) : '';
    }
    case 'Bash': {
      const cmd = input.command as string | undefined;
      return cmd ? truncate(cmd, 40) : '';
    }
    case 'Grep': {
      const pat = input.pattern as string | undefined;
      return pat ? truncate(pat, 30) : '';
    }
    case 'Glob': {
      const pat = input.pattern as string | undefined;
      return pat ? truncate(pat, 30) : '';
    }
    case 'Agent': {
      const desc = input.description as string | undefined;
      return desc ? truncate(desc, 30) : '';
    }
    default:
      return '';
  }
}

function toolResultPreview(block: AnthropicContentBlock): string {
  if (typeof block.content === 'string') {
    const lines = block.content.split('\n').filter(l => l.trim()).length;
    if (lines > 3) return `${lines} lines`;
    return truncate(block.content.replace(/\s+/g, ' ').trim(), 50);
  }
  if (Array.isArray(block.content)) {
    const text = block.content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join(' ');
    if (!text) return '';
    const lines = text.split('\n').filter(l => l.trim()).length;
    if (lines > 3) return `${lines} lines`;
    return truncate(text.replace(/\s+/g, ' ').trim(), 50);
  }
  return '';
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
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

export function logRequest(req: AnthropicRequest, backendName: string, providerHint?: string) {
  const turns = req.messages.filter(m => m.role === 'user').length;
  const tools = req.tools?.length ?? 0;
  const mode = req.stream ? 'stream' : 'sync';
  const input = truncate(lastUserMessage(req), inputLimit());

  const meta = [
    `t${turns}`,
    `${req.max_tokens}tok`,
    tools > 0 ? `${tools}tools` : null,
    mode,
  ].filter(Boolean).join(' · ');

  const target = providerHint
    ? `${c.magenta(backendName)} ${c.dim('via')} ${c.green(providerHint)}`
    : c.magenta(backendName);

  console.log('');
  console.log(`${c.dim(timestamp())}  ${c.cyan(c.bold(req.model))} → ${target}  ${c.dim(meta)}`);
  if (config.level !== 'minimal') console.log(`  ${c.blue('▶')} ${input}`);
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
  const text = truncate(extractResponseText(content), outputLimit());
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
  if (text) console.log(`  ${c.green('◀')} ${truncate(text, outputLimit())}`);
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
  console.log(`  ${c.red(`${status}`)} ${truncate(message, outputLimit())}`);
}

export function logError(_model: string, _backendName: string, err: Error) {
  console.log(`  ${c.red('ERR')} ${err.message}`);
}
