import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const shops = await prisma.minMax.findMany({
    select: { shop: true },
    distinct: ["shop"],
  });
  console.log("Distinct shops in MinMax:", shops);

  const count = await prisma.minMax.count();
  console.log("Total MinMax rows:", count);

  const sample = await prisma.minMax.findMany({ take: 5 });
  console.log("Sample rows:", sample);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
