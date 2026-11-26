import { defineConfig } from 'prisma/config';

// `prisma generate` doesn't need a database; migrate commands read DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgres://lomi:lomi@localhost:5432/lomi',
  },
});
