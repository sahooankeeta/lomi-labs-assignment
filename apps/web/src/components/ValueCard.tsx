import { Alert, Badge, Button, Card, Group, Stack, Text, Textarea, TextInput } from '@mantine/core';
import type { ReviewResultDto, ValueDto, ValueReviewState } from '@lomi/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiPost } from '../api';
import { effectiveValue, previousLabel, primaryAction, type ReviewBody } from '../lib/values';
import { palette } from '../theme';
import { PreviousBlock } from './PreviousBlock';
import { ValueHistory } from './ValueHistory';

// Same pastels as the review ring, always under ink text; the pill keeps the state's name.
const STATE_BG: Record<ValueReviewState, string> = {
  pending: palette.blush,
  approved: palette.sage,
  corrected: palette.sky,
  carried_over: palette.butter,
};

interface Props {
  value: ValueDto;
  selected: boolean;
  /** Called with the value id when the card body is clicked (Task 6 shows its evidence). */
  onSelect: (valueId: string) => void;
  /** False unless the shown version is `extracted`; the server rejects reviews otherwise. */
  canReview: boolean;
  /** The document id, to refresh its detail query after a review. */
  documentId: string;
}

/**
 * One extracted field: its value and evidence page, gap reason, review state, and the
 * Approve / Correct actions. Each action is sent immediately as one review (no drafts).
 */
export function ValueCard({ value, selected, onSelect, canReview, documentId }: Props) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  // The mutation's error stays until the next attempt, so a 400/409 remains visible.
  const review = useMutation({
    mutationFn: (body: ReviewBody) => apiPost<ReviewResultDto>(`/values/${value.id}/review`, body),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });

  const isGap = value.value === null;
  const effective = effectiveValue(value);
  // Own latest review decides; else a carried one. A correction (own or carried) shows the
  // corrected value with the extracted one struck through.
  const corrected = (value.latestReview ?? value.carriedReview)?.action === 'correct';
  const label = previousLabel(value);
  const primary = primaryAction(value);
  const disabled = !canReview || review.isPending;

  const openCorrect = (prefill: string) => {
    setDraft(prefill);
    setNote('');
    setEditing(true);
  };

  return (
    <Card
      withBorder
      padding="md"
      onClick={() => onSelect(value.id)}
      style={{
        cursor: 'pointer',
        // The selected card gets an ink outline (not just a tint) so it reads without colour.
        borderColor: selected ? palette.ink : palette.line,
        borderWidth: selected ? 2 : 1,
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{value.field}</Text>
            {isGap && (
              <Badge bg={palette.butter} c={palette.ink}>
                Gap
              </Badge>
            )}
          </Group>
          <Badge bg={STATE_BG[value.reviewState]} c={palette.ink} fw={500}>
            {value.reviewState}
          </Badge>
        </Group>

        {/* The value, with its evidence page on the right. The quote itself is not repeated
            on the card: selecting the card jumps the PDF to the page and the Text tab
            highlights it. */}
        {!isGap && (
          <Group justify="space-between" wrap="nowrap" align="baseline">
            {corrected ? (
              <Group gap="xs">
                <Text>{effective}</Text>
                <Text td="line-through" c="dimmed">
                  {value.value}
                </Text>
              </Group>
            ) : (
              <Text>{value.value}</Text>
            )}
            {value.evidencePage !== null && (
              <Text size="sm" fs="italic" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                page {value.evidencePage}
              </Text>
            )}
          </Group>
        )}

        {label && (
          <Text size="xs" c="dimmed">
            {label}
          </Text>
        )}

        {isGap && (
          <Text size="sm" c="dimmed">
            {value.gapReason ?? 'No value found'}
          </Text>
        )}

        {value.candidates && value.candidates.length > 0 && (
          <Group gap="xs">
            {value.candidates.map((c) => (
              <Button
                key={`${c.value}-${c.page}`}
                size="compact-xs"
                variant="white"
                c="ink"
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  openCorrect(c.value);
                }}
              >
                {c.value} (p.{c.page})
              </Button>
            ))}
          </Group>
        )}

        {value.previous && (
          <PreviousBlock
            previous={value.previous}
            compact={value.carriedReview !== null}
            earlierCount={value.earlierCount}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}

        {editing ? (
          <form
            // Stop bubbling so typing and saving don't re-select the card.
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = note.trim();
              review.mutate({
                action: 'correct',
                value: draft,
                ...(trimmed ? { note: trimmed } : {}),
              });
            }}
          >
            <Stack gap="xs">
              <TextInput
                label="Correct value"
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                data-autofocus
              />
              <Textarea
                label="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.currentTarget.value)}
                autosize
                minRows={1}
              />
              <Group gap="xs">
                <Button type="submit" size="xs" disabled={disabled || draft.trim() === ''}>
                  Save
                </Button>
                <Button size="xs" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </form>
        ) : (
          <Group gap="xs">
            <Button
              size="xs"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                review.mutate(primary.body);
              }}
            >
              {primary.label}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                openCorrect(effective ?? '');
              }}
            >
              Correct
            </Button>
          </Group>
        )}

        {review.isError && (
          <Alert color="red" p="xs">
            {review.error.message}
          </Alert>
        )}
      </Stack>
      {/* The drawer is portalled but React events still bubble to the Card; stop them so
          interacting with it never re-selects the card. */}
      <div onClick={(e) => e.stopPropagation()}>
        <ValueHistory
          valueId={value.id}
          field={value.field}
          opened={historyOpen}
          onClose={() => setHistoryOpen(false)}
        />
      </div>
    </Card>
  );
}
