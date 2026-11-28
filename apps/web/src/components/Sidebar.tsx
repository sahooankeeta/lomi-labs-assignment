import { Box, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { apiGet, type Health } from '../api';
import { palette } from '../theme';
import { SidebarSlotTarget } from './SidebarSlot';

/** API health (same query as before): coloured dot plus text, so it never relies on colour alone. */
function ApiHealth() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<Health>('/health'),
    refetchInterval: 10_000,
    retry: false,
  });

  const connected = health.data?.pg === 'ok' && health.data?.redis === 'ok';
  const dot = health.isPending ? '#A8A196' : connected ? palette.sage : palette.rose;

  return (
    <Group gap="xs" role="status">
      <Box w={10} h={10} style={{ borderRadius: 999, background: dot, flexShrink: 0 }} />
      <Text size="sm">
        {health.isPending ? 'Checking API…' : connected ? 'API connected' : 'API unavailable'}
      </Text>
    </Group>
  );
}

/**
 * Fixed left sidebar shell on every page: a slot the current page fills (upload form on the
 * list, document summary on the detail page) and API health at the bottom. Styled by
 * layout.css (charcoal card, fixed on wide screens, a plain block below 1000px).
 */
export function Sidebar() {
  return (
    <aside className="app-sidebar">
      <SidebarSlotTarget />
      <div className="app-sidebar-foot">
        <ApiHealth />
      </div>
    </aside>
  );
}
