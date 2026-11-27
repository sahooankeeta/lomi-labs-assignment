import { Alert, Button, Grid, Group, Loader, Stack, Text, Title } from '@mantine/core';
import type { DocumentDetailDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { apiGet, apiPost } from '../api';
import { EvidencePanel } from '../components/EvidencePanel';
import { StatusPill } from '../components/StatusPill';
import { ValueCard } from '../components/ValueCard';
import { progressLabel } from '../lib/format';
import { pollInterval } from '../lib/poll';
import { groupValues } from '../lib/values';

/** Detail page: header, status messages, and the value cards grouped by review need. */
export function DocumentDetail() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const doc = useQuery({
    queryKey: ['document', id],
    queryFn: () => apiGet<DocumentDetailDto>(`/documents/${id}`),
    refetchInterval: (q) => pollInterval(q.state.data ? [q.state.data.status] : []),
  });

  const retry = useMutation({
    mutationFn: () => apiPost(`/documents/${id}/retry`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['document', id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });

  if (doc.isPending) return <Loader />;
  if (doc.isError) {
    return (
      <Alert color="red" title="Could not load document">
        {doc.error.message}
      </Alert>
    );
  }

  const d = doc.data;
  const groups = groupValues(d.values);
  // Default selection: first value needing review, else the first value. Derived so a
  // stale id (e.g. after a re-extraction) falls back instead of pointing at nothing.
  const selected =
    d.values.find((v) => v.id === selectedId)?.id ?? (groups.attention[0] ?? d.values[0])?.id;
  const canReview = d.status === 'extracted';

  const sections: [string, typeof groups.attention][] = [
    ['Needs review', groups.attention],
    ['Carried over', groups.carried],
    ['Done', groups.done],
  ];

  return (
    <Stack>
      <Group>
        <Title order={2}>{d.title}</Title>
        <Text c="dimmed">
          {d.type} · v{d.version.versionNo}
        </Text>
        <StatusPill status={d.status} />
        <Text size="sm">{progressLabel(d.progress)}</Text>
      </Group>

      {d.status === 'failed' && (
        <Alert color="red" title="Extraction failed">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{d.version.error ?? 'Unknown error'}</Text>
            <Button size="xs" loading={retry.isPending} onClick={() => retry.mutate()}>
              Retry
            </Button>
            {retry.isError && <Text size="sm">{retry.error.message}</Text>}
          </Stack>
        </Alert>
      )}

      {(d.status === 'queued' || d.status === 'extracting') && (
        <Group>
          <Loader size="sm" />
          <Text>Extracting…</Text>
        </Group>
      )}

      {d.status === 'extracted' && d.values.length === 0 && (
        <Text c="dimmed">No fields defined for this type.</Text>
      )}

      <Grid>
        <Grid.Col span={6}>
          <Stack>
            {sections.map(
              ([heading, items]) =>
                items.length > 0 && (
                  <Stack key={heading} gap="xs">
                    <Title order={4}>{heading}</Title>
                    {items.map((v) => (
                      <ValueCard
                        key={v.id}
                        value={v}
                        documentId={id}
                        selected={v.id === selected}
                        onSelect={setSelectedId}
                        canReview={canReview}
                      />
                    ))}
                  </Stack>
                ),
            )}
          </Stack>
        </Grid.Col>
        <Grid.Col span={6}>
          <EvidencePanel
            version={d.version}
            selected={d.values.find((v) => v.id === selected) ?? null}
          />
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
