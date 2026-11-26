import { describe, expect, it } from 'vitest';
import { evidenceAppearsIn } from './index.js';

const text = 'Invoice No: INV-2041\nTotal due:   $1,284.50';

describe('evidenceAppearsIn', () => {
  it('accepts a verbatim quote even across line breaks', () => {
    expect(evidenceAppearsIn('INV-2041 Total due: $1,284.50', text)).toBe(true);
  });

  it('rejects a quote that is not in the text', () => {
    expect(evidenceAppearsIn('Total due: $1,300.00', text)).toBe(false);
  });

  it('rejects empty evidence', () => {
    expect(evidenceAppearsIn('   ', text)).toBe(false);
  });
});
