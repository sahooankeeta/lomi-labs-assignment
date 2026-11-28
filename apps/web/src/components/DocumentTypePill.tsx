import { Badge } from '@mantine/core';
import type { DocumentType } from '@lomi/shared';
import { typeColors } from '../theme';

/**
 * Lightly tinted pill for a document type (invoice blue, lease teal, market report violet).
 * Cooler and lighter than the status pastels so type and status never read alike. Presentation
 * only; the type value itself comes from the API unchanged.
 */
export function DocumentTypePill({ type }: { type: DocumentType }) {
  const { bg, fg } = typeColors[type];
  return (
    <Badge bg={bg} c={fg} fw={400} size="sm">
      {type.replace(/_/g, ' ')}
    </Badge>
  );
}
