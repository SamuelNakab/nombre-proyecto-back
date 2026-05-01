import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { PrismaPg } from '@prisma/adapter-pg';

const logLevels =
  process.env.NODE_ENV === 'production'
    ? ['error']
    : ['query', 'error', 'warn'];

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

const prisma = new PrismaClient({ adapter, log: logLevels });

export default prisma;
