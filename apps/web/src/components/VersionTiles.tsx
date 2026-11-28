import { ActionIcon, Group, Skeleton, Text } from '@mantine/core';
import type { VersionSummaryDto } from '@lomi/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { apiGet } from '../api';
import { pollInterval } from '../lib/poll';
import { versionPage } from '../lib/versions';
import { StatusPill } from './StatusPill';

/** Tiles per page. The grid always has this many columns so its width never changes. */
const PAGE_SIZE = 6;

interface Props {
  documentId: string;
  /** The version being shown. */
  versionNo: number;
  /** The document's current version. */
  currentVersionNo: number;
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Short upload time such as "Nov 28, 14:02". */
function shortDate(iso: string): string {
  return dateFmt.format(new Date(iso)).replace(' at ', ', ');
}

/**
 * Version picker: a paginated row of tiles on top of the detail page's main panel.
 * Paginated rather than scrolled because the row has a fixed height (the review below must
 * not jump) and the owner chose pages over a scrolling strip. The shown version lives in the
 * `?version=N` param; choosing the current version clears it, as before.
 */
export function VersionTiles({ documentId, versionNo, currentVersionNo }: Props) {
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

  return (
    <section className="version-tiles" aria-label="Versions">
      <Group justify="space-between" mb={10} h={28}>
        <Text fw={600} fz="md">
          Versions{versions.data ? ` (${total})` : ''}
        </Text>
        {view.pageCount > 1 && (
          <Group gap={8}>
            <ActionIcon
              variant="default"
              size="sm"
              aria-label="Previous versions"
              // Page 0 holds the newest versions, so "previous" moves toward 0.
              disabled={view.page === 0}
              onClick={() => setPage(view.page - 1)}
            >
              ‹
            </ActionIcon>
            <Text fz="sm">
              {view.page + 1} / {view.pageCount}
            </Text>
            <ActionIcon
              variant="default"
              size="sm"
              aria-label="Next versions"
              disabled={view.page === view.pageCount - 1}
              onClick={() => setPage(view.page + 1)}
            >
              ›
            </ActionIcon>
          </Group>
        )}
      </Group>
      {versions.isPending ? (
        <div className="version-grid">
          {Array.from({ length: PAGE_SIZE }, (_, i) => (
            <Skeleton key={i} h={92} radius={14} />
          ))}
        </div>
      ) : versions.isError ? (
        <Text fz="sm" c="red">
          Could not load versions.
        </Text>
      ) : (
        <div className="version-grid">
          {view.items.map((v) => {
            const active = v.versionNo === versionNo;
            return (
              <button
                key={v.id}
                type="button"
                className={active ? 'version-tile version-tile-active' : 'version-tile'}
                aria-pressed={active}
                onClick={() => !active && choose(v.versionNo)}
              >
                <span className="version-tile-head">
                  <b>v{v.versionNo}</b>
                  {v.versionNo === currentVersionNo && (
                    <span className="version-tile-current">current</span>
                  )}
                </span>
                <StatusPill status={v.status} />
                <span className="version-tile-date">{shortDate(v.createdAt)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
