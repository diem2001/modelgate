import type { AnthropicRequest } from '../types.js';

const PASSTHROUGH_HEADERS = [
  'anthropic-version',
  'anthropic-beta',
  'x-api-key',
  'authorization',
] as const;

export async function forwardToAnthropic(
  req: AnthropicRequest,
  baseUrl: string,
  apiKey: string | undefined,
  incomingHeaders: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': incomingHeaders['anthropic-version'] ?? '2023-06-01',
  };

  // Pass through all auth headers from the client (OAuth Bearer or API key)
  for (const h of PASSTHROUGH_HEADERS) {
    if (incomingHeaders[h]) {
      headers[h] = incomingHeaders[h];
    }
  }

  // Only set x-api-key from config if client didn't send auth
  if (!headers['x-api-key'] && !headers['authorization'] && apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const url = `${baseUrl}/v1/messages`;

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });
}
