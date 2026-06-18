import dotenv from "dotenv";
dotenv.config({ path: "./app/.env" });
import fs from "fs";
const { default: prisma } = await import("../app/db.server.js");

const SHOP = "8a7777-3c.myshopify.com";
const data = JSON.parse(fs.readFileSync("./app/scripts/middlewest-suppliers.json", "utf8"));

async function main() {
  const session = await prisma.session.findFirst({ where: { shop: SHOP, isOnline: false } });
  if (!session) throw new Error("No offline session found");
  const accessToken = session.accessToken;

  console.log("Building SKU map from Shopify...");
  const skuMap = new Map();
  let cursor = null, hasNextPage = true;
  while (hasNextPage) {
    const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: `query($cursor:String){products(first:50,after:$cursor){pageInfo{hasNextPage endCursor}edges{node{variants(first:100){edges{node{id sku}}}}}}}`, variables: { cursor } })
    });
    const json = await res.json();
    if (!json.data) { console.error(json); throw new Error("Shopify error"); }
    for (const { node: p } of json.data.products.edges)
      for (const { node: v } of p.variants.edges)
        if (v.sku) skuMap.set(v.sku, v.id);
    hasNextPage = json.data.products.pageInfo.hasNextPage;
    cursor = json.data.products.pageInfo.endCursor;
  }
  console.log(`SKU map built: ${skuMap.size} SKUs`);

  let upserted = 0, unmatched = 0, skipped = 0;
  for (const row of data) {
    if (!row.sku || !row.supplierCode) { skipped++; continue; }
    const variantId = skuMap.get(row.sku);
    if (!variantId) { console.log(`Unmatched: ${row.sku}`); unmatched++; continue; }
    const idx = row.supplier.indexOf(" - ");
    const supplierName = idx !== -1 ? row.supplier.substring(0, idx) : row.supplier;
    const vendorName = idx !== -1 ? row.supplier.substring(idx + 3) : "";
    let supplier = await prisma.supplier.findFirst({ where: { shop: SHOP, name: supplierName } });
    if (!supplier) supplier = await prisma.supplier.create({ data: { shop: SHOP, name: supplierName } });
    await prisma.supplierSku.upsert({
      where: { supplierId_variantId_vendorName: { supplierId: supplier.id, variantId, vendorName } },
      update: { supplierCode: row.supplierCode },
      create: { shop: SHOP, supplierId: supplier.id, variantId, vendorName, supplierCode: row.supplierCode, cost: 0 }
    });
    upserted++;
  }
  console.log(`Done. Upserted: ${upserted}, Unmatched: ${unmatched}, Skipped: ${skipped}`);
}
main().then(() => prisma.$disconnect()).catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
