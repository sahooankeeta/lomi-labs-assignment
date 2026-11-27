import { resolveRepoPath } from '@lomi/shared/node';
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(3000),
  /**
   * Relative values resolve against the repo root, not the cwd: `pnpm --filter @lomi/api dev`
   * runs in `apps/api`, and the worker and seed must see the same folder. Absolute paths
   * (Docker's `/data/uploads`) are kept as given.
   */
  UPLOAD_DIR: z.string().default('./uploads').transform((dir) => resolveRepoPath(dir)),
  /** Where you reach the api from your browser (compose maps the port). Only used in logs. */
  PUBLIC_URL: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof Env>;

/** Parses and validates the api's environment; throws a ZodError naming any bad variable. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
