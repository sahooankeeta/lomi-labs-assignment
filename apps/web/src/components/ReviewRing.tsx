import { Box, Group, RingProgress, Stack, Text } from '@mantine/core';
import type { ProgressDto } from '@lomi/shared';
import { palette } from '../theme';

/**
 * Review progress as a donut: approved / corrected / carried over / pending segments, with the
 * share reviewed in the middle and a legend that spells out every count, so the ring is never
 * the only carrier of the numbers. Built only from the detail response's `progress`.
 */
export function ReviewRing({ progress }: { progress: ProgressDto }) {
  const { approved, corrected, carried_over: carried, pending, gaps, total } = progress;
  const rows = [
    { label: 'Approved', count: approved, color: palette.sage },
    { label: 'Corrected', count: corrected, color: palette.sky },
    { label: 'Carried over', count: carried, color: palette.butter },
    { label: 'Needs review', count: pending, color: palette.blush },
  ];
  // RingProgress takes percentages; an empty version gets an empty ring rather than NaN.
  const sections =
    total === 0
      ? []
      : rows
          .filter((r) => r.count > 0)
          .map((r) => ({
            value: (r.count / total) * 100,
            color: r.color,
            tooltip: `${r.label}: ${r.count}`,
          }));
  const reviewed = total === 0 ? null : Math.round(((total - pending) / total) * 100);

  return (
    <Group gap="lg" wrap="nowrap" align="center">
      <RingProgress
        size={168}
        thickness={22}
        roundCaps
        sectionGap={sections.length > 1 ? 4 : 0}
        rootColor="#fff"
        sections={sections}
        label={
          <Stack gap={0} align="center">
            <Text fz={30} fw={500} lh={1} style={{ letterSpacing: -1 }}>
              {reviewed === null ? '—' : `${reviewed}%`}
            </Text>
            <Text size="xs">reviewed</Text>
          </Stack>
        }
      />
      <Stack gap={6}>
        {rows.map((r) => (
          <Group key={r.label} gap="xs" wrap="nowrap">
            <Box w={12} h={12} style={{ borderRadius: 999, background: r.color, flexShrink: 0 }} />
            <Text size="sm">
              {r.label}: <b>{r.count}</b>
            </Text>
          </Group>
        ))}
        <Text size="xs" c="dimmed">
          {total} fields{gaps > 0 ? ` · ${gaps} gaps` : ''}
        </Text>
      </Stack>
    </Group>
  );
}
