import type { AnthropicRequest } from '../types.js';

const PASSTHROUGH_HEADERS = [
  'anthropic-version',
  'anthropic-beta',
] as const;

export async function forwardToAnthropic(
  req: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  incomingHeaders: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': incomingHeaders['anthropic-version'] ?? '2023-06-01',
  };

  for (const h of PASSTHROUGH_HEADERS) {
    if (incomingHeaders[h]) {
      headers[h] = incomingHeaders[h];
    }
  }

  const url = `${baseUrl}/v1/messages`;

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });
}
