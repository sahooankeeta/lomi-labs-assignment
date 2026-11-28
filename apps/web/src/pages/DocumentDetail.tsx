import { Alert, Anchor, Button, Grid, Group, Loader, Stack, Text, Title } from '@mantine/core';
import type { DocumentDetailDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { apiGet, apiPost } from '../api';
import { DocumentSummary } from '../components/DocumentSummary';
import { SidebarPortal } from '../components/SidebarSlot';
import { EvidencePanel } from '../components/EvidencePanel';
import { ValueCard } from '../components/ValueCard';
import { pollInterval } from '../lib/poll';
import { groupValues } from '../lib/values';

/**
 * Detail page: the review content (status messages, value cards, evidence). The document's
 * summary is portalled into the sidebar from here, so one query feeds both places.
 */
export function DocumentDetail() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The shown version: `?version=N`, else the current one. Anything non-numeric is ignored.
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('version'));
  const version = Number.isInteger(raw) && raw > 0 ? raw : undefined;

  const doc = useQuery({
    // The ['document', id] prefix keeps the existing invalidations matching every version.
    queryKey: ['document', id, version ?? 'current'],
    queryFn: () =>
      apiGet<DocumentDetailDto>(`/documents/${id}${version ? `?version=${version}` : ''}`),
    refetchInterval: (q) => pollInterval(q.state.data ? [q.state.data.status] : []),
  });

  const retry = useMutation({
    mutationFn: () => apiPost(`/documents/${id}/retry`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['document', id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });

  // While loading or failing, the sidebar slot shows the loader / error so the sidebar is
  // never empty; the main panel stays blank until there is a document.
  if (doc.isPending) {
    return (
      <SidebarPortal>
        <Loader size="sm" color="gray" />
      </SidebarPortal>
    );
  }
  if (doc.isError) {
    return (
      <SidebarPortal>
        <Alert color="red" title="Could not load document">
          {doc.error.message}
        </Alert>
      </SidebarPortal>
    );
  }

  const d = doc.data;
  const groups = groupValues(d.values);
  // Default selection: first value needing review, else the first value. Derived so a
  // stale id (e.g. after a re-extraction) falls back instead of pointing at nothing.
  const selected =
    d.values.find((v) => v.id === selectedId)?.id ?? (groups.attention[0] ?? d.values[0])?.id;
  const isCurrent = d.version.versionNo === d.currentVersionNo;
  // Old versions are read-only (the server answers 409 too).
  const canReview = d.status === 'extracted' && isCurrent;

  const sections: [string, typeof groups.attention][] = [
    ['Needs review', groups.attention],
    ['Carried over', groups.carried],
    ['Done', groups.done],
  ];

  return (
    <Stack gap="lg">
      {/* Summary (title, progress, versions, delete) lives in the sidebar, not the main panel. */}
      <SidebarPortal>
        <DocumentSummary d={d} id={id} isCurrent={isCurrent} />
      </SidebarPortal>

      {!isCurrent && (
        <Alert color="gray">
          Viewing v{d.version.versionNo} ({d.status}), read only.{' '}
          <Anchor component="button" type="button" onClick={() => setParams({})}>
            Go to current (v{d.currentVersionNo})
          </Anchor>
        </Alert>
      )}

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
                    <Title order={3} fz="lg">
                      {heading}
                    </Title>
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
