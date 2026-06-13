import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const sessions = await prisma.session.findMany({
  select: { shop: true, isOnline: true, expires: true },
});

console.log(sessions);

await prisma.$disconnect();