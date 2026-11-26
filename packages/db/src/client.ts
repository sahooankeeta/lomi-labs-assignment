import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

/**
 * Prisma 7 with the pg driver adapter (no Rust query engine).
 * The caller owns the client and must `$disconnect()` it on shutdown.
 */
export function createDb(url = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export type Db = PrismaClient;
