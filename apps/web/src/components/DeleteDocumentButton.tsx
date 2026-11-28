import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import type { VersionSummaryDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiRequestError, apiDelete, apiGet } from '../api';
import { deleteSummary } from '../lib/versions';
import { StatusPill } from './StatusPill';

interface Props {
  documentId: string;
  title: string;
  currentVersionNo: number;
}

/**
 * "Delete" button plus its confirmation modal. The modal lists every version that will go
 * (shared `['versions', id]` cache with VersionBar). Deletion is whole-document on purpose:
 * earlier versions must stay queryable, so there is no per-version delete.
 */
export function DeleteDocumentButton({ documentId, title, currentVersionNo }: Props) {
  const [opened, setOpened] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

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
    void navigate('/');
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
      {/* A pastel-red pill with dark red text: stands apart from the black primary pills. */}
      <Button color="red" variant="light" c="red.9" size="sm" onClick={open}>
        Delete
      </Button>
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
