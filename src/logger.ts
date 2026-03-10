import type { LoggingConfig } from './config.js';
import type { AnthropicRequest, AnthropicContentBlock } from './types.js';

let config: LoggingConfig = { level: 'standard' };

export function initLogger(cfg: LoggingConfig) {
  config = cfg;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function cyan(s: string): string { return `\x1b[36m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function extractTextPreview(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return truncate(content, 120);
  const texts = content.filter(b => b.type === 'text').map(b => b.text ?? '');
  const toolUses = content.filter(b => b.type === 'tool_use').map(b => b.name ?? '?');
  const toolResults = content.filter(b => b.type === 'tool_result');
  const parts: string[] = [];
  if (texts.length > 0) parts.push(truncate(texts.join(' '), 120));
  if (toolUses.length > 0) parts.push(`[tools: ${toolUses.join(', ')}]`);
  if (toolResults.length > 0) parts.push(`[${toolResults.length} tool result(s)]`);
  return parts.join(' ') || '(empty)';
}

function extractSystemPreview(system: AnthropicRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return truncate(system, 80);
  return truncate(
    system.filter(b => b.type === 'text').map(b => b.text ?? '').join(' '),
    80,
  );
}

export function logRequest(req: AnthropicRequest, backendName: string) {
  const ts = dim(timestamp());
  const arrow = `${cyan(req.model)} → ${bold(backendName)}`;
  const mode = req.stream ? yellow('stream') : green('sync');
  const msgs = `${req.messages.length} msg`;
  const tokens = `max=${req.max_tokens}`;
  const tools = req.tools?.length ? ` | ${req.tools.length} tools` : '';

  console.log(`${ts} ${arrow} ${mode} | ${msgs} | ${tokens}${tools}`);

  if (config.level === 'minimal') return;

  // Standard: show system preview + last message
  if (req.system) {
    console.log(`  ${dim('system:')} ${extractSystemPreview(req.system)}`);
  }

  if (config.level === 'verbose') {
    // Show all messages
    for (const msg of req.messages) {
      console.log(`  ${dim(msg.role + ':')} ${extractTextPreview(msg.content)}`);
    }
  } else {
    // Standard: show last user message
    const lastUser = [...req.messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      console.log(`  ${dim('user:')} ${extractTextPreview(lastUser.content)}`);
    }
  }

  if (config.level === 'verbose' && req.tools?.length) {
    console.log(`  ${dim('tools:')} ${req.tools.map(t => t.name).join(', ')}`);
  }
}

export function logResponseBody(content: AnthropicContentBlock[]) {
  if (config.level === 'minimal') return;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      console.log(`  ${dim('assistant:')} ${truncate(block.text, 200)}`);
    } else if (block.type === 'tool_use') {
      const args = truncate(JSON.stringify(block.input), 120);
      console.log(`  ${dim('tool_use:')} ${yellow(block.name ?? '?')}(${args})`);
    }
  }
}

export function logResponse(
  model: string,
  backendName: string,
  status: number,
  durationMs: number,
) {
  const ts = dim(timestamp());
  const arrow = `${cyan(model)} ← ${bold(backendName)}`;
  const statusStr = status >= 200 && status < 300 ? green(String(status)) : red(String(status));
  const duration = dim(`${durationMs}ms`);

  console.log(`${ts} ${arrow} ${statusStr} ${duration}`);
}

export function logStreamStart(model: string, backendName: string) {
  if (config.level === 'minimal') return;
  const ts = dim(timestamp());
  console.log(`${ts} ${cyan(model)} ← ${bold(backendName)} ${yellow('streaming...')}`);
}

export function logStreamContent(text: string) {
  if (config.level === 'minimal') return;
  if (text) {
    console.log(`  ${dim('assistant:')} ${truncate(text, 200)}`);
  }
}

export function logStreamToolUse(name: string, args: string) {
  if (config.level === 'minimal') return;
  console.log(`  ${dim('tool_use:')} ${yellow(name)}(${truncate(args, 120)})`);
}

export function logStreamEnd(model: string, backendName: string, durationMs: number) {
  const ts = dim(timestamp());
  const duration = dim(`${durationMs}ms`);
  console.log(`${ts} ${cyan(model)} ← ${bold(backendName)} ${green('stream done')} ${duration}`);
}

export function logError(model: string, backendName: string, err: Error) {
  const ts = dim(timestamp());
  console.log(`${ts} ${cyan(model)} ${red('ERROR')} ${bold(backendName)}: ${err.message}`);
}
