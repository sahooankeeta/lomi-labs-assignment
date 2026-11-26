import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(3000),
  UPLOAD_DIR: z.string().default('./uploads'),
});

export type Env = z.infer<typeof Env>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
