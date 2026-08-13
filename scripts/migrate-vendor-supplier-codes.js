import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const SHOP = process.env.SHOP || "your-shop.myshopify.com"; // set this
const SUPPLIER_ID = process.argv[3];
const OLD_VENDOR = process.argv[4];
const NEW_VENDOR = process.argv[5];

const SNAPSHOT_FILE = "./vendor-migration-snapshot.json";

async function findSupplier() {
  const name = process.argv[3];
  const suppliers = await prisma.supplier.findMany({
    where: { shop: SHOP, name: { contains: name, mode: "insensitive" } },
  });
  if (suppliers.length === 0) {
    console.log(`No suppliers found matching "${name}"`);
  } else {
    suppliers.forEach((s) => console.log(`${s.id}  —  ${s.name}`));
  }
}

async function snapshot() {
  const fs = await import("fs");
  const rows = await prisma.supplierSku.findMany({
    where: { shop: SHOP, supplierId: SUPPLIER_ID, vendorName: OLD_VENDOR },
    select: { variantId: true, supplierCode: true, cost: true },
  });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(rows, null, 2));
  console.log(`Snapshot saved: ${rows.length} rows -> ${SNAPSHOT_FILE}`);
}

async function cleanup() {
  const del = await prisma.supplierSku.deleteMany({
    where: { shop: SHOP, supplierId: SUPPLIER_ID, vendorName: OLD_VENDOR },
  });
  await prisma.vendorSupplier.deleteMany({
    where: { shop: SHOP, supplierId: SUPPLIER_ID, vendorName: OLD_VENDOR },
  });
  console.log(`Deleted ${del.count} SupplierSku rows + stale VendorSupplier row for ${OLD_VENDOR}`);
}

async function reattach() {
  const fs = await import("fs");
  const rows = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
  let updated = 0;
  for (const row of rows) {
    const res = await prisma.supplierSku.updateMany({
      where: { shop: SHOP, supplierId: SUPPLIER_ID, variantId: row.variantId, vendorName: NEW_VENDOR },
      data: { supplierCode: row.supplierCode, cost: row.cost },
    });
    updated += res.count;
  }
  console.log(`Reattached codes to ${updated}/${rows.length} rows`);
}

const command = process.argv[2];
if (command === "find") await findSupplier();
else if (command === "snapshot") await snapshot();
else if (command === "cleanup") await cleanup();
else if (command === "reattach") await reattach();
else console.log("Usage: node scripts/migrate-vendor-supplier-codes.js <find|snapshot|cleanup|reattach> <name|supplierId> [oldVendor] [newVendor]");

await prisma.$disconnect();