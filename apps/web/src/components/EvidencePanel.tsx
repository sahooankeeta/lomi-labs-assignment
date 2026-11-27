import {
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Mark,
  ScrollArea,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import type { ValueDto, VersionDto } from '@lomi/shared';
import { useEffect, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';
import { highlightSegments } from '../lib/highlight';
import '../pdf';

/**
 * Evidence for the selected value: the PDF (jumps to the evidence page, no on-PDF highlight)
 * and the parsed text (quote highlighted via evidenceStart/evidenceEnd).
 */
export function EvidencePanel({
  version,
  selected,
}: {
  version: VersionDto;
  selected: ValueDto | null;
}) {
  const [tab, setTab] = useState<string | null>('pdf');
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [width, setWidth] = useState(400);
  const box = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);

  // A value without a page (gap) leaves the page where it was.
  // Adjust state during render (React's documented alternative to a setState effect): jump when
  // the selection changes; a value without a page (gap) leaves the page where it was.
  const [seenId, setSeenId] = useState<string | undefined>(undefined);
  if (selected?.id !== seenId) {
    setSeenId(selected?.id);
    if (selected?.evidencePage != null) setPage(selected.evidencePage);
  }

  // The PDF tab is unmounted while hidden, so observe whenever the box (re)appears.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);

  const text = version.parsedText;
  const seg =
    text === null
      ? null
      : highlightSegments(text, selected?.evidenceStart ?? null, selected?.evidenceEnd ?? null);

  useEffect(() => {
    if (tab === 'text') markRef.current?.scrollIntoView({ block: 'center' });
  }, [tab, selected?.id, selected?.evidenceStart, selected?.evidenceEnd]);

  return (
    <Card withBorder>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="pdf">PDF</Tabs.Tab>
          <Tabs.Tab value="text">Text</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="pdf" pt="sm">
          <Stack gap="xs">
            <Group>
              <Button
                size="xs"
                variant="default"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Text size="sm">
                page {page} of {numPages || '…'}
              </Text>
              <Button
                size="xs"
                variant="default"
                disabled={page >= numPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </Group>
            {loadError && (
              <Alert color="red" title="Could not load the PDF">
                {loadError}
              </Alert>
            )}
            <div ref={box}>
              <Document
                file={`/api/versions/${version.id}/file`}
                loading={<Loader size="sm" />}
                error={null}
                onLoadSuccess={({ numPages: n }) => {
                  setLoadError(null);
                  setNumPages(n);
                  setPage((p) => Math.min(Math.max(p, 1), n));
                }}
                onLoadError={(e) => setLoadError(e.message)}
              >
                <Page
                  pageNumber={page}
                  width={width}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              </Document>
            </div>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="text" pt="sm">
          {seg === null ? (
            <Text c="dimmed">Text not parsed yet</Text>
          ) : (
            <ScrollArea h={600}>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {seg.before}
                {seg.match && <Mark ref={markRef}>{seg.match}</Mark>}
                {seg.after}
              </pre>
            </ScrollArea>
          )}
        </Tabs.Panel>
      </Tabs>
    </Card>
  );
}
