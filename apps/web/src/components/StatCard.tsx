import { Box, Group, Paper, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { palette } from '../theme';

interface Props {
  /** Pastel background; text on it is always ink, so any of the palette pastels works. */
  bg: string;
  icon: ReactNode;
  label: string;
  value: number | string;
  caption: string;
  /** Short context in the white chip at the right, e.g. "3 ready". Omitted when empty. */
  chip?: string;
}

/**
 * A pastel summary tile: icon + label, a big number, a muted caption and a small white chip.
 * Presentational only; callers compute the numbers from data they already have.
 */
export function StatCard({ bg, icon, label, value, caption, chip }: Props) {
  return (
    <Paper radius="lg" p="lg" bg={bg} c={palette.ink} style={{ flex: 1, minWidth: 220 }}>
      <Group gap="xs" mb="sm">
        <Box
          w={28}
          h={28}
          style={{
            borderRadius: 999,
            border: `1.5px solid ${palette.ink}`,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          {icon}
        </Box>
        <Text fw={600} fz="lg">
          {label}
        </Text>
      </Group>
      <Group justify="space-between" align="flex-end" wrap="nowrap">
        <div>
          <Text fz={40} fw={500} lh={1.1} style={{ letterSpacing: -1 }}>
            {value}
          </Text>
          {/* Ink at reduced emphasis via size, not a light grey, to keep 4.5:1 on pastels. */}
          <Text size="xs" c={palette.ink} mt={4}>
            {caption}
          </Text>
        </div>
        {chip && (
          <Text
            size="xs"
            fw={600}
            px={10}
            py={4}
            bg="#fff"
            style={{ borderRadius: 8, whiteSpace: 'nowrap' }}
          >
            {chip}
          </Text>
        )}
      </Group>
    </Paper>
  );
}

const svg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true };
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Inline glyphs for the stat cards; inline SVG so no icon dependency is added. */
export const StatIcons = {
  documents: (
    <svg {...svg}>
      <rect x="5" y="3" width="14" height="18" rx="2" {...stroke} />
      <path d="M9 8h6M9 12h6" {...stroke} />
    </svg>
  ),
  review: (
    <svg {...svg}>
      <path d="M4 12l5 5L20 6" {...stroke} />
    </svg>
  ),
  clock: (
    <svg {...svg}>
      <circle cx="12" cy="12" r="8" {...stroke} />
      <path d="M12 8v4l3 2" {...stroke} />
    </svg>
  ),
};
