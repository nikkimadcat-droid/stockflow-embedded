import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
let prisma = new PrismaClient();

const SHOP = "8a7777-3c.myshopify.com";

const REMAP = {
  "gid://shopify/Location/477478": "gid://shopify/Location/75810996475",
  "gid://shopify/Location/477479": "gid://shopify/Location/75811258619",
  "gid://shopify/Location/477480": "gid://shopify/Location/75811291387",
};

for (const [oldLoc, newLoc] of Object.entries(REMAP)) {
  const rows = await prisma.minMax.findMany({ where: { shop: SHOP, locationId: oldLoc } });
  console.log(`Remapping ${rows.length} rows from ${oldLoc} -> ${newLoc}`);
  let updated = 0, deleted = 0;
  for (const row of rows) {
    try {
      await prisma.minMax.update({
        where: { id: row.id },
        data: { locationId: newLoc },
      });
      updated++;
    } catch (err) {
      if (err.code === "P2002") {
        await prisma.minMax.delete({ where: { id: row.id } });
        deleted++;
      } else {
        console.warn("retry due to:", err.code || err.message);
        try { await prisma.$disconnect(); } catch {}
        prisma = new PrismaClient();
        await prisma.$connect();
        // retry once
        try {
          await prisma.minMax.update({ where: { id: row.id }, data: { locationId: newLoc } });
          updated++;
        } catch (err2) {
          if (err2.code === "P2002") {
            await prisma.minMax.delete({ where: { id: row.id } });
            deleted++;
          } else {
            console.error("FAILED row", row.id, err2.code || err2.message);
          }
        }
      }
    }
    if ((updated + deleted) % 500 === 0) {
      console.log(`  progress: updated=${updated}, deleted=${deleted}`);
      try { await prisma.$disconnect(); } catch {}
      prisma = new PrismaClient();
      await prisma.$connect();
    }
  }
  console.log(`Done ${oldLoc}: updated=${updated}, deleted=${deleted}`);
}

await prisma.$disconnect();
