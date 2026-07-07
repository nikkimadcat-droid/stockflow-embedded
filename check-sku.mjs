import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const TARGET_SKU = "M16432";

async function main() {
  const fromPO = await prisma.purchaseOrderItem.findFirst({
    where: { sku: TARGET_SKU },
    orderBy: { updatedAt: "desc" },
  });

  const fromStocktake = await prisma.stocktakeLine.findFirst({
    where: { sku: TARGET_SKU },
    orderBy: { updatedAt: "desc" },
  });

  const variantId = fromPO?.variantId || fromStocktake?.variantId;

  if (!variantId) {
    console.log(`Could not find a variantId for SKU ${TARGET_SKU} in PurchaseOrderItem or StocktakeLine.`);
    console.log("Try pasting the variantId directly if you have it from the min/max page network request.");
    return;
  }

  console.log(`Found variantId for SKU ${TARGET_SKU}: ${variantId}\n`);

  const rows = await prisma.minMax.findMany({
    where: { variantId },
    orderBy: { locationId: "asc" },
  });

  console.log(`MinMax rows for this variant across all locations:`);
  console.table(rows.map(r => ({
    locationId: r.locationId,
    minLevel: r.minLevel,
    maxLevel: r.maxLevel,
    casePackSize: r.casePackSize,
    updatedAt: r.updatedAt.toISOString(),
  })));
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
