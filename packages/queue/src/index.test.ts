import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  enqueueExtraction,
  extractionJobId,
  extractionJobOptions,
  type ExtractionJob,
} from './index.js';

describe('extractionJobId', () => {
  it('carries the attempt number and contains no colon', () => {
    const id = '0b9f3a52-6a1c-4c53-9a53-5d2d0b6d2f11';
    expect(extractionJobId(id, 2)).toBe(`extract-${id}-2`);
    // BullMQ only accepts ':' in custom ids through a legacy exemption marked for removal.
    expect(extractionJobId(id, 2)).not.toContain(':');
  });
});

describe('enqueueExtraction', () => {
  it('adds the job with the attempt-scoped id', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueExtraction({ add } as unknown as Queue<ExtractionJob>, 'v1', 3);
    expect(add).toHaveBeenCalledWith('extract', { versionId: 'v1' }, { jobId: 'extract-v1-3' });
  });

  it('rejects when the add fails, so callers can log it', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis down'));
    await expect(
      enqueueExtraction({ add } as unknown as Queue<ExtractionJob>, 'v1', 0),
    ).rejects.toThrow('redis down');
  });
});

describe('extractionJobOptions', () => {
  it('removes finished jobs so a reused job id (handoff, retry) can be enqueued again', () => {
    expect(extractionJobOptions.removeOnComplete).toBe(true);
    expect(extractionJobOptions.removeOnFail).toBe(true);
  });
});
