import { prepareTestDatabase } from '@lomi/db/testing';

export default async function setup() {
  await prepareTestDatabase();
}
