import { Alert, Button, Group, Select, Stack } from '@mantine/core';
import type { DocumentSummaryDto, VersionSummaryDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { apiGet, apiUpload } from '../api';
import { uploadErrorMessage } from '../lib/format';
import { PdfDrop } from './PdfDrop';
import { pollInterval } from '../lib/poll';
import { versionOptionsOrFallback } from '../lib/versions';

interface Props {
  documentId: string;
  /** The version being shown. */
  versionNo: number;
  /** The document's current version; only it can be replaced by an upload. */
  currentVersionNo: number;
}

/**
 * Version switcher plus, on the current version only, the "Upload new version" control.
 * The shown version lives in the `?version=N` search param, so it survives reloads and links.
 */
export function VersionBar({ documentId, versionNo, currentVersionNo }: Props) {
  const queryClient = useQueryClient();
  const [, setParams] = useSearchParams();
  const [file, setFile] = useState<File | null>(null);

  const versions = useQuery({
    queryKey: ['versions', documentId],
    queryFn: () => apiGet<VersionSummaryDto[]>(`/documents/${documentId}/versions`),
    // A new version is `queued` right after upload, so the list polls until it settles.
    refetchInterval: (q) => pollInterval((q.state.data ?? []).map((v) => v.status)),
  });

  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('file', f);
      return apiUpload<DocumentSummaryDto>(`/documents/${documentId}/versions`, form);
    },
    // 201 (new version) and 200 (identical to current) both just need a refresh.
    onSuccess: () => {
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['versions', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });

  const choose = (value: string | null) => {
    if (!value) return;
    // The current version is the default view, so it needs no param.
    setParams(Number(value) === currentVersionNo ? {} : { version: value });
  };

  return (
    <Stack gap="xs">
      <Group align="flex-end">
        <Select
          label="Version"
          data={versionOptionsOrFallback(versions.data, versionNo, currentVersionNo)}
          value={String(versionNo)}
          onChange={choose}
          allowDeselect={false}
          w={240}
        />
        {versionNo === currentVersionNo && (
          <>
            <PdfDrop label="New version" file={file} onChange={setFile} />
            <Button
              loading={upload.isPending}
              disabled={!file}
              onClick={() => file && upload.mutate(file)}
            >
              Upload new version
            </Button>
          </>
        )}
      </Group>
      {upload.isError && (
        <Alert color="red" title="Upload failed">
          {uploadErrorMessage(upload.error)}
        </Alert>
      )}
    </Stack>
  );
}
