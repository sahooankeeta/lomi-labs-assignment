import { ApiError } from '@lomi/shared';

/** A failed API call. `code` is the server's error code, or 'network' when fetch itself threw. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiError['error'] | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** All API calls go through /api, proxied to Fastify by Vite (dev) or nginx (docker). */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiRequestError(0, 'network', 'Cannot reach the API');
  }
  if (!res.ok) {
    // Prefer the server's own message; fall back to the HTTP status line for non-JSON errors.
    const parsed = ApiError.safeParse(await res.json().catch(() => null));
    if (parsed.success)
      throw new ApiRequestError(res.status, parsed.data.error, parsed.data.message);
    throw new ApiRequestError(res.status, 'internal', `${res.status} ${res.statusText}`);
  }
  // 204 (DELETE) has no body to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

/** POST a JSON body (or none). */
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** DELETE a resource; resolves with nothing on 204. */
export function apiDelete(path: string): Promise<void> {
  return request<void>(path, { method: 'DELETE' });
}

/** POST multipart form data; the browser sets the boundary header itself. */
export function apiUpload<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: 'POST', body: form });
}

export interface Health {
  pg: 'ok' | 'down';
  redis: 'ok' | 'down';
}
