import { Box, Group, RingProgress, Stack, Text } from '@mantine/core';
import type { ProgressDto } from '@lomi/shared';
import { palette } from '../theme';

/**
 * Review progress as a donut: approved / corrected / carried over / pending segments, with the
 * share reviewed in the middle and a legend that spells out every count, so the ring is never
 * the only carrier of the numbers. Sized for the sidebar (100px ring beside a one-line-per-row legend). Built only from the detail response's `progress`.
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
    <Group gap="sm" wrap="nowrap" align="center">
      <RingProgress
        size={100}
        thickness={12}
        roundCaps
        sectionGap={sections.length > 1 ? 3 : 0}
        rootColor="#4a463f"
        sections={sections}
        label={
          <Stack gap={0} align="center">
            <Text fz={19} fw={600} lh={1}>
              {reviewed === null ? '—' : `${reviewed}%`}
            </Text>
            <Text fz={11} lh={1.3}>
              reviewed
            </Text>
          </Stack>
        }
      />
      <Stack gap={6}>
        {rows.map((r) => (
          <Group key={r.label} gap={6} wrap="nowrap">
            <Box w={10} h={10} style={{ borderRadius: 999, background: r.color, flexShrink: 0 }} />
            <Text fz={13} lh={1.3} style={{ whiteSpace: 'nowrap' }}>
              {r.label}: <b>{r.count}</b>
            </Text>
          </Group>
        ))}
        <Text fz={12} c="dimmed">
          {total} fields{gaps > 0 ? ` · ${gaps} gaps` : ''}
        </Text>
      </Stack>
    </Group>
  );
}
