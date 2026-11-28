import {
  Alert,
  Anchor,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { DocumentDetailDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { apiGet, apiPost } from '../api';
import { DeleteDocumentButton } from '../components/DeleteDocumentButton';
import { EvidencePanel } from '../components/EvidencePanel';
import { ReviewRing } from '../components/ReviewRing';
import { StatusPill } from '../components/StatusPill';
import { ValueCard } from '../components/ValueCard';
import { VersionBar } from '../components/VersionBar';
import { progressLabel } from '../lib/format';
import { pollInterval } from '../lib/poll';
import { palette } from '../theme';
import { groupValues } from '../lib/values';

/**
 * Subtle pill back to the list. Always a plain link to `/` (never history), so it also works
 * when the page was opened directly. The arrow is inline SVG: no icon library.
 */
function BackToList() {
  return (
    <Link
      to="/"
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 14px 6px 10px',
        borderRadius: 999,
        border: `1px solid ${palette.line}`,
        background: palette.surface,
        color: palette.ink,
        fontSize: 14,
        fontWeight: 500,
        textDecoration: 'none',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M19 12H5M11 6l-6 6 6 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      All documents
    </Link>
  );
}

/** Detail page: header, status messages, and the value cards grouped by review need. */
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
      <BackToList />
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={6}>
          <Title order={1}>{d.title}</Title>
          <Group gap="sm">
            <Text c="dimmed">
              {d.type} · v{d.version.versionNo}
            </Text>
            <StatusPill status={d.status} />
            <Text size="sm">{progressLabel(d.progress)}</Text>
          </Group>
        </Stack>
        <DeleteDocumentButton
          documentId={id}
          title={d.title}
          currentVersionNo={d.currentVersionNo}
        />
      </Group>

      <Group gap="md" align="stretch" wrap="nowrap">
        <Card p="lg" style={{ flexShrink: 0 }}>
          <Text fw={600} fz="lg" mb="sm">
            Review progress
          </Text>
          <ReviewRing progress={d.progress} />
        </Card>
        <Card p="lg" style={{ flex: 1, minWidth: 0 }}>
          <VersionBar
            documentId={id}
            versionNo={d.version.versionNo}
            currentVersionNo={d.currentVersionNo}
          />
        </Card>
      </Group>

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
