import { ActionIcon, Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import type { VersionSummaryDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ApiRequestError, apiDelete, apiGet } from '../api';
import { deleteSummary } from '../lib/versions';
import { reviewColors } from '../theme';
import { StatusPill } from './StatusPill';

interface Props {
  documentId: string;
  title: string;
  currentVersionNo: number;
  /**
   * How the modal is opened: `'button'` (default) is the pill "Delete" button used on the detail
   * page; `'icon'` is a compact trash icon for table rows. The modal and mutation are shared.
   */
  variant?: 'button' | 'icon';
}

/** Inline trash icon (no icon dependency); decorative, the button carries the aria-label. */
function TrashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/**
 * "Delete" button plus its confirmation modal. The modal lists every version that will go
 * (shared `['versions', id]` cache with VersionBar). Deletion is whole-document on purpose:
 * earlier versions must stay queryable, so there is no per-version delete. After a delete the
 * user lands on the list (see `leave`).
 */
export function DeleteDocumentButton({
  documentId,
  title,
  currentVersionNo,
  variant = 'button',
}: Props) {
  const [opened, setOpened] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const versions = useQuery({
    queryKey: ['versions', documentId],
    queryFn: () => apiGet<VersionSummaryDto[]>(`/documents/${documentId}/versions`),
    enabled: opened,
  });

  // Success and "already gone" (double click, another tab) end the same way.
  const leave = () => {
    // Remove, not invalidate: the detail poll would otherwise refetch and hit a 404.
    queryClient.removeQueries({ queryKey: ['document', documentId] });
    queryClient.removeQueries({ queryKey: ['versions', documentId] });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
    // Already on the list (deleted from a row): stay put, and do not push a duplicate entry.
    if (pathname !== '/') void navigate('/');
  };

  const remove = useMutation({
    mutationFn: () => apiDelete(`/documents/${documentId}`),
    onSuccess: leave,
    onError: (e) => {
      if (e instanceof ApiRequestError && e.code === 'not_found') leave();
    },
  });

  const open = () => {
    remove.reset();
    setOpened(true);
    // A version uploaded since page load (e.g. from another tab) should show up.
    if (versions.isFetched) void versions.refetch();
  };

  const summary = deleteSummary(versions.data ?? [], currentVersionNo);
  const count = summary.lines.length;

  return (
    <>
      {variant === 'icon' ? (
        // stopPropagation: a row (or its link) must never react to this click.
        <ActionIcon
          color="red"
          variant="subtle"
          c="red.9"
          aria-label={`Delete ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          <TrashIcon />
        </ActionIcon>
      ) : (
        // A solid pastel-red pill with dark red text (same pair as the failed status pill, 7.4:1):
        // stands apart from the primary pills and reads on cream and on the charcoal sidebar.
        <Button
          size="sm"
          bg={reviewColors.failed.bg}
          c={reviewColors.failed.fg}
          onClick={open}
        >
          Delete
        </Button>
      )}
      <Modal opened={opened} onClose={() => setOpened(false)} title={`Delete "${title}"?`}>
        <Stack>
          <Text>{summary.heading}</Text>
          {versions.isFetching && !versions.data ? (
            <Loader size="sm" />
          ) : (
            summary.lines.map((l) => (
              <Group key={l.label} gap="xs">
                <StatusPill status={l.status} />
                <Text fw={700}>{l.label}</Text>
                {l.current && <Text>(current)</Text>}
                <Text size="sm" c="dimmed">
                  {new Date(l.createdAt).toLocaleString()}
                </Text>
              </Group>
            ))
          )}
          <Text size="sm">
            Their extracted values, reviews and extraction history are deleted too. This can&apos;t
            be undone.
          </Text>
          {remove.isError &&
            !(remove.error instanceof ApiRequestError && remove.error.code === 'not_found') && (
              <Alert color="red" title="Delete failed">
                {remove.error.message}
              </Alert>
            )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpened(false)}>
              Cancel
            </Button>
            <Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
              {count > 0 ? `Delete ${count} ${count === 1 ? 'version' : 'versions'}` : 'Delete'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
