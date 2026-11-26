import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router';
import { apiGet, type Health } from './api';

export function Layout() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<Health>('/health'),
    refetchInterval: 10_000,
    retry: false,
  });

  const connected = health.data?.pg === 'ok' && health.data?.redis === 'ok';

  return (
    <div
      style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '0 auto', padding: 24 }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to="/" style={{ fontWeight: 600, textDecoration: 'none', color: 'inherit' }}>
          Lomi Review
        </Link>
        <span style={{ fontSize: 13, color: connected ? 'green' : 'crimson' }}>
          {health.isPending ? 'Checking API…' : connected ? 'API connected' : 'API unavailable'}
        </span>
      </header>
      <main style={{ marginTop: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
