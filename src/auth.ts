import type { AuthConfig } from './config.js';

interface CachedToken {
  validUntil: number;
  orgId?: string;
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
    // Re-check org allowlist even for cached tokens (allowlist may have changed)
    if (!isOrgAllowed(cached.orgId, config.allowedOrgIds)) return false;
    return true;
  }

  try {
    // Try as x-api-key first
    const res = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
      },
    });

    if (res.ok) {
      return cacheAndValidateOrg(token, res, config);
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
      return cacheAndValidateOrg(token, res2, config);
    }

    tokenCache.delete(token);
    return false;
  } catch {
    return false;
  }
}

function cacheAndValidateOrg(token: string, res: Response, config: AuthConfig): boolean {
  const orgId = res.headers.get('anthropic-organization-id') ?? undefined;
  const ttlMs = config.cacheTtlMinutes * 60 * 1000;
  tokenCache.set(token, { validUntil: Date.now() + ttlMs, orgId });

  if (!isOrgAllowed(orgId, config.allowedOrgIds)) return false;
  return true;
}

function isOrgAllowed(orgId: string | undefined, allowedOrgIds: string[] | undefined): boolean {
  // No allowlist configured = deny all (secure by default)
  if (!allowedOrgIds || allowedOrgIds.length === 0) return false;
  // Allowlist configured but token has no org = deny
  if (!orgId) return false;
  return allowedOrgIds.includes(orgId);
}

export function invalidateToken(token: string): void {
  tokenCache.delete(token);
}
