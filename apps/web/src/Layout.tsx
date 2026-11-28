import { Box, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router';
import { apiGet, type Health } from './api';
import { palette } from './theme';

/**
 * Slim top bar: brand link on the left, API health on the right (same query as before; it
 * used to live in the sidebar).
 */
function TopBar() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<Health>('/health'),
    refetchInterval: 10_000,
    retry: false,
  });

  const connected = health.data?.pg === 'ok' && health.data?.redis === 'ok';
  const dot = health.isPending ? '#A8A196' : connected ? palette.sage : palette.rose;

  return (
    <Group component="header" justify="space-between" px="xl" py="sm">
      <Text
        component={Link}
        to="/"
        fz={20}
        fw={600}
        c={palette.ink}
        td="none"
        style={{ letterSpacing: -0.5 }}
      >
        Lomi Review
      </Text>
      {/* Status text always accompanies the dot, so it never relies on colour alone. */}
      <Group gap="xs" role="status">
        <Box w={10} h={10} style={{ borderRadius: 999, background: dot, flexShrink: 0 }} />
        <Text size="sm">
          {health.isPending ? 'Checking API…' : connected ? 'API connected' : 'API unavailable'}
        </Text>
      </Group>
    </Group>
  );
}

/**
 * App chrome: a cream page holding one large rounded panel, with the top bar above the
 * full-width routed page.
 */
export function Layout() {
  return (
    <Box p={12} mih="100vh">
      <Box
        p={12}
        style={{
          background: palette.panel,
          border: `1px solid ${palette.line}`,
          borderRadius: 24,
          minHeight: 'calc(100vh - 24px)',
        }}
      >
        <TopBar />
        {/* minWidth 0 lets the detail page's PDF column shrink instead of overflowing. */}
        <Box component="main" px="xl" py="lg" style={{ minWidth: 0 }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
