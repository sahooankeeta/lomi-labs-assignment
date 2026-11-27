# 0006. Prisma 7 with the pg driver adapter

## Context

The skeleton used Drizzle. The job description says the team uses Prisma heavily, and the
coordination rules are mostly small guarded updates and transactions.

## Decision

Prisma 7.10 (stable; 8.0 is still RC) with the `prisma-client` generator and `@prisma/adapter-pg`
(no Rust engine, ESM). Mapping of the rules:

- guarded claim and finish: `updateMany({ where: { id, status, activeRunId } })`, check `count`;
- finish plus values plus carry-over: an interactive `$transaction`;
- duplicate backstop: `createMany({ skipDuplicates: true })` and `@@unique([versionId, field])`;
- row lock for a new version: one `$queryRaw` `SELECT ... FOR UPDATE`;
- the value-xor-gap `CHECK`, which `schema.prisma` cannot express, is hand-added to the migration SQL.

Migrations run with `prisma migrate deploy` in the compose `migrate` service; `prisma generate`
runs in the db package's `build`, so turbo orders it before dependents.

## Alternatives

- Keep Drizzle. Rejected: no match with the team's stack; the rules map equally well to Prisma.
- Raw SQL everywhere. Rejected: loses typed models for little gain.

## Consequences

- Hand-written SQL stays in migrations; a schema change must not drop the CHECKs.
- Prisma 7 generates the client at build time, so the Docker build needs the db package first.
