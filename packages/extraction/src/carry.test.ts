import { describe, expect, it } from 'vitest';
import { isUnchanged } from './carry.js';
import { INVOICE_V1 } from './testdata.js';

const prevTotal = { value: '$5,230.29', evidence: 'Total Due: $5,230.29' };

describe('isUnchanged', () => {
  it('same value, quote present -> true', () => {
    expect(isUnchanged(prevTotal, { value: '$5,230.29' }, INVOICE_V1, 'money')).toBe(true);
  });

  it('formatting-only difference still unchanged', () => {
    expect(isUnchanged(prevTotal, { value: '5230.29' }, INVOICE_V1, 'money')).toBe(true);
    expect(
      isUnchanged(
        { value: '2025-09-14', evidence: 'Issue Date: 2025-09-14' },
        { value: 'September 14, 2025' },
        INVOICE_V1,
        'date',
      ),
    ).toBe(true);
  });

  it('quote moved is still unchanged', () => {
    const moved = 'NEW HEADER LINE\n\n' + INVOICE_V1;
    expect(isUnchanged(prevTotal, { value: '$5,230.29' }, moved, 'money')).toBe(true);
  });

  it('whitespace differences in the quote still match', () => {
    const prev = { value: '$5,230.29', evidence: 'Total  Due:\n$5,230.29' };
    expect(isUnchanged(prev, { value: '$5,230.29' }, INVOICE_V1, 'money')).toBe(true);
  });

  it('value changed -> false', () => {
    expect(isUnchanged(prevTotal, { value: '$6,126.45' }, INVOICE_V1, 'money')).toBe(false);
  });

  it('quote gone -> false', () => {
    const gone = INVOICE_V1.replace('Total Due: $5,230.29', 'Amount Payable: $5,230.29');
    expect(isUnchanged(prevTotal, { value: '$5,230.29' }, gone, 'money')).toBe(false);
  });

  it('either side a gap -> false', () => {
    expect(
      isUnchanged({ value: null, evidence: null }, { value: '$5,230.29' }, INVOICE_V1, 'money'),
    ).toBe(false);
    expect(isUnchanged(prevTotal, { value: null }, INVOICE_V1, 'money')).toBe(false);
    expect(isUnchanged({ value: null, evidence: null }, { value: null }, INVOICE_V1, 'money')).toBe(
      false,
    );
  });

  it('next value not parseable as the type -> false', () => {
    expect(isUnchanged(prevTotal, { value: 'abc' }, INVOICE_V1, 'money')).toBe(false);
  });
});
