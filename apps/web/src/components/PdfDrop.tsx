import { Input, Text } from '@mantine/core';
import { Dropzone, PDF_MIME_TYPE } from '@mantine/dropzone';
import { useState } from 'react';
import { dropRejectionMessage } from '../lib/format';

/** The server's upload cap (multipart `fileSize`); checking it here saves a doomed upload. */
const MAX_BYTES = 20 * 1024 * 1024;

interface Props {
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}

/**
 * A PDF picker that accepts a dragged file or a click to browse. It only selects the
 * file; the parent form still uploads it, so dropping and choosing behave the same.
 * Type and size are checked here for fast feedback, but the server still checks the
 * PDF magic bytes, because a file's MIME type is whatever the browser guesses.
 */
export function PdfDrop({ label, file, onChange, disabled }: Props) {
  const [rejected, setRejected] = useState<string | null>(null);

  return (
    <Input.Wrapper label={label} error={rejected}>
      <Dropzone
        accept={PDF_MIME_TYPE}
        maxSize={MAX_BYTES}
        multiple={false}
        disabled={disabled}
        onDrop={(files) => {
          setRejected(null);
          onChange(files[0] ?? null);
        }}
        onReject={(rejections) => {
          onChange(null);
          setRejected(dropRejectionMessage(rejections.flatMap((r) => r.errors.map((e) => e.code))));
        }}
        className="pdf-drop"
        p="sm"
        mih={56}
        style={{ display: 'flex', alignItems: 'center' }}
      >
        <Dropzone.Accept>
          <Text size="sm">Drop the PDF here</Text>
        </Dropzone.Accept>
        <Dropzone.Reject>
          <Text size="sm" c="red">
            Only one PDF, up to 20 MB
          </Text>
        </Dropzone.Reject>
        <Dropzone.Idle>
          <Text size="sm" c={file ? undefined : 'dimmed'}>
            {file ? file.name : 'Drag a PDF here, or click to choose'}
          </Text>
        </Dropzone.Idle>
      </Dropzone>
    </Input.Wrapper>
  );
}
