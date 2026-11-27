import { Anchor, Badge, Container, Group } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router';
import { apiGet, type Health } from './api';

/** App chrome: title link, API health badge, and the routed page in a wide container. */
export function Layout() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<Health>('/health'),
    refetchInterval: 10_000,
    retry: false,
  });

  const connected = health.data?.pg === 'ok' && health.data?.redis === 'ok';

  return (
    // xl so the detail page's two columns fit side by side.
    <Container size="xl" py="md">
      <Group justify="space-between">
        <Anchor component={Link} to="/" fw={600} c="inherit" underline="never">
          Lomi Review
        </Anchor>
        <Badge color={health.isPending ? 'gray' : connected ? 'green' : 'red'} variant="light">
          {health.isPending ? 'Checking API…' : connected ? 'API connected' : 'API unavailable'}
        </Badge>
      </Group>
      <main style={{ marginTop: 24 }}>
        <Outlet />
      </main>
    </Container>
  );
}
