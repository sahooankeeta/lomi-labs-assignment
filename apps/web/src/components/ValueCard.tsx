import {
  Alert,
  Badge,
  Blockquote,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import type { ReviewResultDto, ValueDto, ValueReviewState } from '@lomi/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiPost } from '../api';
import { effectiveValue } from '../lib/values';

const STATE_COLOR: Record<ValueReviewState, string> = {
  pending: 'orange',
  approved: 'green',
  corrected: 'blue',
  carried_over: 'gray',
};

type ReviewBody = { action: 'approve' } | { action: 'correct'; value: string; note?: string };

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
 * One extracted field: its value, gap reason or evidence, review state, and the
 * Approve / Correct actions. Each action is sent immediately as one review (no drafts).
 */
export function ValueCard({ value, selected, onSelect, canReview, documentId }: Props) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');

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
  const corrected = value.reviewState === 'corrected';
  const disabled = !canReview || review.isPending;

  const openCorrect = (prefill: string) => {
    setDraft(prefill);
    setNote('');
    setEditing(true);
  };

  return (
    <Card
      withBorder
      padding="sm"
      onClick={() => onSelect(value.id)}
      style={{
        cursor: 'pointer',
        borderColor: selected ? 'var(--mantine-color-blue-6)' : undefined,
        borderWidth: selected ? 2 : undefined,
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{value.field}</Text>
            <Text size="xs" c="dimmed">
              {value.fieldType}
            </Text>
            {isGap && (
              <Badge color="yellow" variant="light">
                Gap
              </Badge>
            )}
          </Group>
          <Badge color={STATE_COLOR[value.reviewState]}>{value.reviewState}</Badge>
        </Group>

        {corrected ? (
          <Group gap="xs">
            <Text>{effective}</Text>
            {value.value !== null && (
              <Text td="line-through" c="dimmed">
                {value.value}
              </Text>
            )}
          </Group>
        ) : (
          !isGap && <Text>{value.value}</Text>
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
                variant="light"
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

        {value.evidence && (
          <Blockquote
            p="xs"
            cite={value.evidencePage !== null ? `page ${value.evidencePage}` : undefined}
          >
            {value.evidence}
          </Blockquote>
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
                <Button size="xs" variant="default" onClick={() => setEditing(false)}>
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
                review.mutate({ action: 'approve' });
              }}
            >
              {isGap ? 'Confirm absent' : 'Approve'}
            </Button>
            <Button
              size="xs"
              variant="default"
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
    </Card>
  );
}
