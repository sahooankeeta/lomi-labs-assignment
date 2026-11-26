/** All API calls go through /api, proxied to Fastify by Vite (dev) or nginx (docker). */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface Health {
  pg: 'ok' | 'down';
  redis: 'ok' | 'down';
}
