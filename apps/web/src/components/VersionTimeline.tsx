import { ActionIcon, Group, Skeleton, Text } from '@mantine/core';
import type { VersionSummaryDto } from '@lomi/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { apiGet } from '../api';
import { pollInterval } from '../lib/poll';
import { versionPage } from '../lib/versions';

/** Steps per page. The row always has this many slots so the steps never shift. */
const PAGE_SIZE = 10;

interface Props {
  documentId: string;
  /** The version being shown. */
  versionNo: number;
  /** The document's current version. */
  currentVersionNo: number;
}

/**
 * Version picker: a horizontal timeline of numbered steps on top of the detail page's main
 * panel, oldest on the left. The current version is filled; an older version being viewed
 * gets a ring. Only numbers are shown (status and upload time of the shown version are in the
 * sidebar). Paginated rather than scrolled because the row has a fixed height (the review
 * below must not jump) and the owner chose pages over a scrolling strip. The shown version
 * lives in the `?version=N` param; choosing the current version clears it, as before.
 */
export function VersionTimeline({ documentId, versionNo, currentVersionNo }: Props) {
  const [, setParams] = useSearchParams();
  // null = the page holding the shown version; set only once the user pages manually.
  const [page, setPage] = useState<number | null>(null);

  // Switching version snaps back to the page that holds it. Done during render (React's
  // "adjust state on prop change" pattern) rather than in an effect, to avoid a stale frame.
  const [seenVersionNo, setSeenVersionNo] = useState(versionNo);
  if (seenVersionNo !== versionNo) {
    setSeenVersionNo(versionNo);
    setPage(null);
  }

  const versions = useQuery({
    queryKey: ['versions', documentId],
    queryFn: () => apiGet<VersionSummaryDto[]>(`/documents/${documentId}/versions`),
    // A new version is `queued` right after upload, so the list polls until it settles.
    refetchInterval: (q) => pollInterval((q.state.data ?? []).map((v) => v.status)),
  });

  const choose = (value: number) => {
    // The current version is the default view, so it needs no param.
    setParams(value === currentVersionNo ? {} : { version: String(value) });
  };

  const total = versions.data?.length ?? 0;
  const view = versionPage(versions.data ?? [], versionNo, page, PAGE_SIZE);

  // versionPage pages newest first (page 0 = newest); each page is drawn oldest-left, so
  // the left arrow moves to older versions (a higher page number).
  const steps = [...view.items].reverse();

  return (
    <section aria-label="Versions">
      <Group justify="space-between" mb={10} h={28}>
        <Text fw={600} fz="md">
          Versions{versions.data ? ` (${total})` : ''}
        </Text>
        {view.pageCount > 1 && (
          <Group gap={8}>
            <ActionIcon
              variant="default"
              size="sm"
              aria-label="Older versions"
              disabled={view.page === view.pageCount - 1}
              onClick={() => setPage(view.page + 1)}
            >
              ‹
            </ActionIcon>
            <ActionIcon
              variant="default"
              size="sm"
              aria-label="Newer versions"
              disabled={view.page === 0}
              onClick={() => setPage(view.page - 1)}
            >
              ›
            </ActionIcon>
          </Group>
        )}
      </Group>
      {versions.isPending ? (
        <Skeleton h={36} radius="xl" />
      ) : versions.isError ? (
        <Text fz="sm" c="red">
          Could not load versions.
        </Text>
      ) : (
        <ol className="version-steps">
          {steps.map((v) => {
            const shown = v.versionNo === versionNo;
            const current = v.versionNo === currentVersionNo;
            const cls = ['version-step-dot'];
            if (current) cls.push('version-step-current');
            if (shown) cls.push('version-step-shown');
            if (v.status === 'failed') cls.push('version-step-failed');
            return (
              <li key={v.id} className="version-step">
                <button
                  type="button"
                  className={cls.join(' ')}
                  aria-current={shown ? 'page' : undefined}
                  aria-label={`Version ${v.versionNo}${current ? ', current' : ''} (${v.status})`}
                  title={`v${v.versionNo} · ${v.status}`}
                  onClick={() => !shown && choose(v.versionNo)}
                >
                  {v.versionNo}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
