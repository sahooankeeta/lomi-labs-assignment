/**
 * Pure extraction logic: no fs, network, DB, env reads or clock, so it can be
 * unit-tested without Postgres, Redis or an LLM.
 */
export * from './text.js';
export * from './values.js';
export * from './pages.js';
