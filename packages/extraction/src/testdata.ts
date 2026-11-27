import type { FieldDef } from '@lomi/shared';

/** Invoice v1 as unpdf parses fixtures/documents/invoice-001.pdf (one page). */
export const INVOICE_V1 =
  'MERIDIAN OFFICE SUPPLIES LLC\n482 Commerce Way, Suite 210\nEastport, CA 94702\nINVOICE\nInvoice Number: INV-2025-0847\nIssue Date: 2025-09-14\nDue Date: 2025-10-14\nPayment Terms: Net 30\nBill To:\nLomi Labs Inc.\n900 Mission Street, Floor 5\nSan Francisco, CA 94103\nDescription Qty Unit Price Amount\n----------------------------------------------------------------------\nStanding desk, model SD-400 4 $589.00 $2,356.00\nErgonomic chair, model EC-220 4 $412.50 $1,650.00\nMonitor arm, dual, model MA-2 6 $89.00 $534.00\nDelivery and assembly 1 $275.00 $275.00\n----------------------------------------------------------------------\nSubtotal: $4,815.00\nSales Tax (8.625%): $415.29\nTotal Due: $5,230.29\nPlease reference the invoice number on all payments.\nPayments by ACH to the account on file. A late fee of 1.5% per month\napplies to balances outstanding past the due date.';

export const INVOICE_FIELDS: FieldDef[] = [
  { field: 'invoice_number', type: 'string' },
  { field: 'issue_date', type: 'date' },
  { field: 'due_date', type: 'date' },
  { field: 'vendor_name', type: 'string' },
  { field: 'total_amount', type: 'money' },
];

/** A correct model answer for invoice v1. */
export const INVOICE_V1_OUTPUT = {
  fields: [
    {
      field: 'invoice_number',
      value: 'INV-2025-0847',
      evidence: 'Invoice Number: INV-2025-0847',
      gap_reason: null,
    },
    {
      field: 'issue_date',
      value: '2025-09-14',
      evidence: 'Issue Date: 2025-09-14',
      gap_reason: null,
    },
    { field: 'due_date', value: '2025-10-14', evidence: 'Due Date: 2025-10-14', gap_reason: null },
    {
      field: 'vendor_name',
      value: 'Meridian Office Supplies LLC',
      evidence: 'MERIDIAN OFFICE SUPPLIES LLC',
      gap_reason: null,
    },
    {
      field: 'total_amount',
      value: '$5,230.29',
      evidence: 'Total Due: $5,230.29',
      gap_reason: null,
    },
  ],
};

export const LEASE_FIELDS: FieldDef[] = [
  { field: 'tenant_name', type: 'string' },
  { field: 'monthly_rent', type: 'money' },
  { field: 'security_deposit', type: 'money' },
  { field: 'lease_start', type: 'date' },
  { field: 'term_months', type: 'number' },
];

/** Lease excerpt clause 2 as unpdf parses it (the term wraps across a line break). */
export const LEASE_TERM_CLAUSE =
  '1. PARTIES. This Lease Agreement is entered into between Harborview\nResidential LP ("Landlord") and Dana Okafor ("Tenant").\n2. TERM. The initial term of this Lease shall be twenty-four (24)\nmonths, commencing on March 1, 2025 and ending on February 28, 2027,';

/** A correct model answer for the lease excerpt; term_months is returned "as written" (Gemini, live run). */
export const LEASE_OUTPUT = {
  fields: [
    {
      field: 'tenant_name',
      value: 'Dana Okafor',
      evidence: 'Dana Okafor ("Tenant")',
      gap_reason: null,
    },
    {
      field: 'monthly_rent',
      value: '$2,350.00',
      evidence: 'monthly rent of $2,350.00',
      gap_reason: null,
    },
    {
      field: 'security_deposit',
      value: '$3,525.00',
      evidence: 'the sum of $3,525.00',
      gap_reason: null,
    },
    {
      field: 'lease_start',
      value: 'March 1, 2025',
      evidence: 'commencing on March 1, 2025',
      gap_reason: null,
    },
    {
      field: 'term_months',
      value: 'twenty-four (24)',
      evidence: 'twenty-four (24)\nmonths',
      gap_reason: null,
    },
  ],
};
