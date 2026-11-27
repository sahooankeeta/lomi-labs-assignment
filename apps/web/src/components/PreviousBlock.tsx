import { Anchor, Blockquote, Stack, Text } from '@mantine/core';
import type { PreviousValueDto } from '@lomi/shared';

interface Props {
  previous: PreviousValueDto;
  /** True when the review was carried over: a label and quote are enough. */
  compact: boolean;
  /** Number of earlier versions; the history link shows when more than just `previous` exists. */
  earlierCount: number;
  onOpenHistory: () => void;
}

/**
 * The previous version's quote (and, for pending values, its page, correction and note)
 * beside the current value, so the reviewer can compare old and new side by side.
 */
export function PreviousBlock({ previous, compact, earlierCount, onOpenHistory }: Props) {
  const r = previous.review;
  return (
    <Stack gap={4}>
      <Text size="xs" fw={600} c="dimmed">
        Previous (v{previous.versionNo})
      </Text>
      {previous.evidence && (
        <Blockquote
          p="xs"
          c="dimmed"
          cite={
            !compact && previous.evidencePage !== null ? `page ${previous.evidencePage}` : undefined
          }
        >
          {previous.evidence}
        </Blockquote>
      )}
      {!compact && r?.action === 'correct' && (
        <Text size="xs" c="dimmed">
          Corrected to {r.correctedValue}
        </Text>
      )}
      {!compact && r?.note && (
        <Text size="xs" c="dimmed">
          Note: {r.note}
        </Text>
      )}
      {earlierCount > 1 && (
        <Anchor
          component="button"
          type="button"
          size="xs"
          ta="left"
          onClick={(e) => {
            // The card is a click target for selection; opening history must not re-select it.
            e.stopPropagation();
            onOpenHistory();
          }}
        >
          History ({earlierCount} earlier versions)
        </Anchor>
      )}
    </Stack>
  );
}
