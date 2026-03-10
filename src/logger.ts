import type { LoggingConfig } from './config.js';
import type { AnthropicRequest, AnthropicContentBlock } from './types.js';

let config: LoggingConfig = { level: 'standard' };

export function initLogger(cfg: LoggingConfig) {
  config = cfg;
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
  bgDim:   (s: string) => `\x1b[48;5;236m${s}\x1b[0m`,
};

// ── Helpers ────────────────────────────────────────

const W = 64; // box width

function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function wrap(text: string, indent: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/);
  let current = '';
  for (const word of words) {
    if (current && (current.length + 1 + word.length) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.map((l, i) => i === 0 ? l : `${indent}${l}`);
}

function topLine(label: string): string {
  const inner = ` ${label} `;
  const rest = '─'.repeat(Math.max(0, W - 4 - inner.length));
  return c.dim(`┌──${inner}${rest}┐`);
}

function midLine(label?: string): string {
  if (label) {
    const inner = ` ${label} `;
    const rest = '─'.repeat(Math.max(0, W - 4 - inner.length));
    return c.dim(`├──${inner}${rest}┤`);
  }
  return c.dim(`├${'─'.repeat(W - 2)}┤`);
}

function botLine(): string {
  return c.dim(`└${'─'.repeat(W - 2)}┘`);
}

function row(content: string): string {
  return `${c.dim('│')} ${content}`;
}

// ── Content extraction ─────────────────────────────

function extractText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join(' ');
}

function extractToolUses(content: string | AnthropicContentBlock[]): Array<{ name: string; args: string }> {
  if (typeof content === 'string') return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name ?? '?', args: truncate(JSON.stringify(b.input), 80) }));
}

function extractToolResults(content: string | AnthropicContentBlock[]): number {
  if (typeof content === 'string') return 0;
  return content.filter(b => b.type === 'tool_result').length;
}

function extractSystemPreview(system: AnthropicRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return truncate(system, 50);
  return truncate(
    system.filter(b => b.type === 'text').map(b => b.text ?? '').join(' '),
    50,
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Public API ─────────────────────────────────────

export function logRequest(req: AnthropicRequest, backendName: string) {
  const time = c.dim(timestamp());
  const model = c.cyan(c.bold(req.model));
  const backend = c.magenta(backendName);
  const mode = req.stream ? c.yellow('STREAM') : c.green('SYNC');

  console.log('');
  console.log(topLine(time));
  console.log(row(`${model}  →  ${backend}  ${mode}`));

  // Meta line
  const meta: string[] = [];
  meta.push(`${req.messages.length} messages`);
  meta.push(`max_tokens=${req.max_tokens}`);
  if (req.tools?.length) meta.push(`${req.tools.length} tools`);
  if (req.temperature !== undefined) meta.push(`temp=${req.temperature}`);
  console.log(row(c.dim(meta.join('  ·  '))));

  if (config.level === 'minimal') return;

  // System prompt
  if (req.system) {
    console.log(midLine('SYSTEM'));
    console.log(row(c.dim(extractSystemPreview(req.system))));
  }

  // Messages
  console.log(midLine('INPUT'));

  if (config.level === 'verbose') {
    for (const msg of req.messages) {
      const label = msg.role === 'user' ? c.blue('USER') : c.green('ASST');
      const text = extractText(msg.content);
      const tools = extractToolUses(msg.content);
      const results = extractToolResults(msg.content);

      if (text) {
        const wrapped = wrap(truncate(text, 300), '         ', W - 12);
        console.log(row(`${label}  ${wrapped.join('\n')}`));
      }
      for (const t of tools) {
        console.log(row(`  ${c.yellow('⚡')} ${c.bold(t.name)}(${c.dim(t.args)})`));
      }
      if (results > 0) {
        console.log(row(`  ${c.dim(`↩ ${results} tool result(s)`)}`));
      }
    }
  } else {
    // Standard: last user message only
    const lastUser = [...req.messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      const text = extractText(lastUser.content);
      const tools = extractToolUses(lastUser.content);
      const results = extractToolResults(lastUser.content);

      if (text) {
        const wrapped = wrap(truncate(text, 300), '       ', W - 10);
        console.log(row(`${c.blue('USER')}  ${wrapped.join('\n')}`));
      }
      for (const t of tools) {
        console.log(row(`  ${c.yellow('⚡')} ${c.bold(t.name)}(${c.dim(t.args)})`));
      }
      if (results > 0) {
        console.log(row(`  ${c.dim(`↩ ${results} tool result(s)`)}`));
      }
    }
  }

  if (config.level === 'verbose' && req.tools?.length) {
    console.log(midLine('TOOLS'));
    const names = req.tools.map(t => t.name);
    // Show in rows of ~4
    for (let i = 0; i < names.length; i += 4) {
      console.log(row(c.dim(names.slice(i, i + 4).join(', '))));
    }
  }
}

export function logResponseSync(
  model: string,
  backendName: string,
  status: number,
  durationMs: number,
  content?: AnthropicContentBlock[],
) {
  console.log(midLine('OUTPUT'));

  if (content) {
    logContentBlocks(content);
  }

  const statusStr = status >= 200 && status < 300 ? c.green(`${status}`) : c.red(`${status}`);
  const duration = c.bold(formatDuration(durationMs));

  console.log(midLine());
  console.log(row(`${statusStr}  ${duration}  ${c.dim('sync')}`));
  console.log(botLine());
}

export function logStreamStart(_model: string, _backendName: string) {
  // Nothing here — the box is still open from logRequest
}

export function logStreamResponse(
  model: string,
  backendName: string,
  durationMs: number,
  text: string,
  toolCalls: Map<number, { name: string; args: string }>,
) {
  console.log(midLine('OUTPUT'));

  if (text) {
    const wrapped = wrap(truncate(text, 500), '       ', W - 10);
    console.log(row(`${c.green('ASST')}  ${wrapped.join('\n')}`));
  }
  for (const tc of toolCalls.values()) {
    console.log(row(`  ${c.yellow('⚡')} ${c.bold(tc.name)}(${c.dim(truncate(tc.args, 80))})`));
  }

  const duration = c.bold(formatDuration(durationMs));
  console.log(midLine());
  console.log(row(`${c.green('200')}  ${duration}  ${c.dim('stream')}`));
  console.log(botLine());
}

export function logResponseError(
  model: string,
  backendName: string,
  status: number,
  message: string,
) {
  console.log(midLine('ERROR'));
  console.log(row(c.red(truncate(message, W - 6))));
  console.log(midLine());
  console.log(row(`${c.red(String(status))}`));
  console.log(botLine());
}

export function logError(model: string, backendName: string, err: Error) {
  console.log(midLine('ERROR'));
  console.log(row(c.red(err.message)));
  console.log(botLine());
}

// ── Internal ───────────────────────────────────────

function logContentBlocks(content: AnthropicContentBlock[]) {
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      const wrapped = wrap(truncate(block.text, 500), '       ', W - 10);
      console.log(row(`${c.green('ASST')}  ${wrapped.join('\n')}`));
    } else if (block.type === 'tool_use') {
      const args = truncate(JSON.stringify(block.input), 80);
      console.log(row(`  ${c.yellow('⚡')} ${c.bold(block.name ?? '?')}(${c.dim(args)})`));
    }
  }
}
