import { prepareTestDatabase } from './testing.js';

export default async function setup() {
  await prepareTestDatabase();
}
