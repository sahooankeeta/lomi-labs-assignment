import type { FieldType } from '@lomi/shared';
import { describe, expect, it } from 'vitest';
import { normalizeValue, valueInQuote } from './values.js';

describe('normalizeValue', () => {
  it.each<[string, FieldType, string | null]>([
    ['$5,230.29', 'money', '5230.29'],
    ['1985', 'money', '1985'],
    ['$1,985.00', 'money', '1985'],
    ['4.2%', 'percent', '4.2'],
    ['24', 'number', '24'],
    ['-12.50', 'number', '-12.5'],
    ['March 1, 2025', 'date', '2025-03-01'],
    ['1 March 2025', 'date', '2025-03-01'],
    ['Mar 1, 2025', 'date', '2025-03-01'],
    ['2025-09-14', 'date', '2025-09-14'],
    ['2025-02-30', 'date', null],
    ['Smarch 1, 2025', 'date', null],
    ['abc', 'money', null],
    ['1.2.3', 'number', null],
    ['twenty-four (24)', 'number', '24'],
    ['24 months', 'number', '24'],
    ['USD 1,985.00', 'money', '1985'],
    ['approx. 4.2%', 'percent', '4.2'],
    ['between 4.2% and 4.9%', 'percent', null],
    ['24 or 25', 'number', null],
    ['twenty-four', 'number', null],
    ['24 (24)', 'number', '24'],
    ['  Meridian   Office “Supplies” ', 'string', 'meridian office "supplies"'],
  ])('(%j, %s) → %j', (value, type, expected) => {
    expect(normalizeValue(value, type)).toBe(expected);
  });
});

describe('valueInQuote', () => {
  it.each<[string, string, FieldType, boolean]>([
    ['5230.29', 'Total Due: $5,230.29', 'money', true],
    ['5230.30', 'Total Due: $5,230.29', 'money', false],
    ['4.2', 'vacancy rate declined to 4.2%, down from 4.9%', 'percent', true],
    ['4.9%', 'vacancy rate declined to 4.2%, down from 4.9%', 'percent', true],
    ['5', 'vacancy rate declined to 4.2%', 'percent', false],
    ['24', 'twenty-four (24)\nmonths', 'number', true],
    ['twenty-four (24)', 'term of this Lease shall be twenty-four (24)', 'number', true],
    ['twenty-four (25)', 'term of this Lease shall be twenty-four (24)', 'number', false],
    ['24 months', 'for a term of twenty-four (24)\nmonths', 'number', true],
    ['2025-03-01', 'commencing on March 1, 2025', 'date', true],
    ['2025-03-02', 'commencing on March 1, 2025', 'date', false],
    ['2025-09-14', 'Invoice Date: 2025-09-14', 'date', true],
    ['Dana Okafor', 'and Dana Okafor ("Tenant")', 'string', true],
    ['Meridian Office Supplies LLC', 'MERIDIAN OFFICE SUPPLIES LLC', 'string', true],
    ['INV-2025-0848', 'Invoice Number: INV-2025-0847', 'string', false],
    ['abc', 'Total Due: $5,230.29', 'money', false],
  ])('(%j in %j as %s) → %s', (value, quote, type, expected) => {
    expect(valueInQuote(value, quote, type)).toBe(expected);
  });
});
