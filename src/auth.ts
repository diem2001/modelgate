import type { AuthConfig } from './config.js';

interface CachedToken {
  validUntil: number;
}

const tokenCache = new Map<string, CachedToken>();

export function extractToken(headers: Record<string, string>): string | null {
  const auth = headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const apiKey = headers['x-api-key'];
  if (apiKey) return apiKey;
  return null;
}

export async function validateToken(token: string, config: AuthConfig): Promise<boolean> {
  if (!config.enabled) return true;

  const cached = tokenCache.get(token);
  if (cached && Date.now() < cached.validUntil) {
    return true;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
      },
    });

    if (res.ok) {
      const ttlMs = config.cacheTtlMinutes * 60 * 1000;
      tokenCache.set(token, { validUntil: Date.now() + ttlMs });
      return true;
    }

    // Try as OAuth Bearer token
    const res2 = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
    });

    if (res2.ok) {
      const ttlMs = config.cacheTtlMinutes * 60 * 1000;
      tokenCache.set(token, { validUntil: Date.now() + ttlMs });
      return true;
    }

    tokenCache.delete(token);
    return false;
  } catch {
    return false;
  }
}

export function invalidateToken(token: string): void {
  tokenCache.delete(token);
}
