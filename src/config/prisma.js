import 'dotenv/config';
import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const logLevels =
  process.env.NODE_ENV === 'production'
    ? ['error']
    : ['query', 'error', 'warn'];

const prisma = new PrismaClient({ log: logLevels });

export default prisma;
