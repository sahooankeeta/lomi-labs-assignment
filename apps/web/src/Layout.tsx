import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router';
import { apiGet, type Health } from './api';
import { palette } from './theme';

/** Small "stacked pages" glyph for the Documents nav item; inline so no icon library is added. */
function DocumentsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Black left sidebar: brand, the one nav item, and the API health at the bottom (it used to
 * be a header badge). Documents is always the active item because both routes live under it.
 */
function Sidebar() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<Health>('/health'),
    refetchInterval: 10_000,
    retry: false,
  });

  const connected = health.data?.pg === 'ok' && health.data?.redis === 'ok';
  const dot = health.isPending ? '#A8A196' : connected ? palette.sage : palette.rose;

  return (
    <Stack
      component="nav"
      aria-label="Main"
      justify="space-between"
      w={232}
      p="lg"
      style={{
        flexShrink: 0,
        background: palette.ink,
        color: '#fff',
        borderRadius: 20,
        position: 'sticky',
        top: 12,
        height: 'calc(100vh - 48px)',
      }}
    >
      <Stack gap="xl">
        <Text
          component={Link}
          to="/"
          fz={24}
          fw={600}
          c="#fff"
          td="none"
          style={{ letterSpacing: -0.5 }}
        >
          Lomi Review
        </Text>
        <Stack gap={6}>
          <Text size="xs" c="#B8B2A7" fw={500}>
            General
          </Text>
          <UnstyledButton
            component={Link}
            to="/"
            aria-current="page"
            px="sm"
            py={8}
            style={{
              color: '#fff',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.35)',
              background: 'rgba(255,255,255,0.08)',
            }}
          >
            <Group gap="sm">
              <DocumentsIcon />
              <Text size="sm" fw={500} c="#fff">
                Documents
              </Text>
            </Group>
          </UnstyledButton>
        </Stack>
      </Stack>

      {/* Status text always accompanies the dot, so it never relies on colour alone. */}
      <Group gap="xs" role="status">
        <Box w={10} h={10} style={{ borderRadius: 999, background: dot, flexShrink: 0 }} />
        <Text size="sm" c="#fff">
          {health.isPending ? 'Checking API…' : connected ? 'API connected' : 'API unavailable'}
        </Text>
      </Group>
    </Stack>
  );
}

/**
 * App chrome: a cream page holding one large rounded panel, with the black sidebar on the
 * left and the routed page beside it.
 */
export function Layout() {
  return (
    <Box p={12} mih="100vh">
      <Box
        p={12}
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          background: palette.panel,
          border: `1px solid ${palette.line}`,
          borderRadius: 24,
          minHeight: 'calc(100vh - 24px)',
        }}
      >
        <Sidebar />
        {/* minWidth 0 lets the detail page's PDF column shrink instead of overflowing. */}
        <Box component="main" px="xl" py="lg" style={{ flex: 1, minWidth: 0 }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
