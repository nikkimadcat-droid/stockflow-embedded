import dotenv from "dotenv";
dotenv.config({ path: "./app/.env" });

import fs from "fs";
const { default: prisma } = await import("../app/db.server.js");

const SHOP = "8a7777-3c.myshopify.com";
const DATA_FILE = "./scripts/data/stocky-suppliers.json";
const UNMATCHED_FILE = "./scripts/data/unmatched-skus.json";

async function main() {
  // --- Load and parse data file ---
  let raw = fs.readFileSync(DATA_FILE, "utf8");
  raw = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  const data = JSON.parse(raw);

  // --- Get offline access token ---
  const session = await prisma.session.findFirst({
    where: { shop: SHOP, isOnline: false },
  });
  if (!session) {
    throw new Error(`No offline session found for shop ${SHOP}`);
  }
  const accessToken = session.accessToken;

  // --- Build SKU -> variantId map by paginating Shopify Admin API ---
  console.log("Building SKU map from Shopify...");
  const skuMap = new Map();
  let cursor = null;
  let hasNextPage = true;
  let productCount = 0;
  let variantCount = 0;

  while (hasNextPage) {
    const query = `
      query ($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${SHOP}/admin/api/2025-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: { cursor } }),
      }
    );

    const json = await response.json();

    if (!json.data) {
      console.error("Unexpected response from Shopify:", JSON.stringify(json, null, 2));
      throw new Error("Shopify API returned no data — check token/scopes.");
    }

    const { edges, pageInfo } = json.data.products;

    for (const { node: product } of edges) {
      productCount++;
      for (const { node: variant } of product.variants.edges) {
        variantCount++;
        if (variant.sku) {
          skuMap.set(variant.sku, variant.id);
        }
      }
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  console.log(`Mapped ${skuMap.size} SKUs across ${productCount} products (${variantCount} variants).`);

  // --- Process each supplier entry ---
  const unmatched = [];
  let suppliersProcessed = 0;
  let skusUpserted = 0;
  let skusSkippedNoCost = 0;

  for (const entry of data) {
    // Split "Distributor - Vendor" naming convention
    let supplierName = entry.supplier;
    let vendorName = "";
    const dashIdx = supplierName.indexOf(" - ");
    if (dashIdx !== -1) {
      vendorName = supplierName.substring(dashIdx + 3);
      supplierName = supplierName.substring(0, dashIdx);
    }

    // Find or create Supplier
    let supplier = await prisma.supplier.findFirst({
      where: { shop: SHOP, name: supplierName },
    });
    if (!supplier) {
      supplier = await prisma.supplier.create({
        data: { shop: SHOP, name: supplierName },
      });
      console.log(`Created supplier: ${supplierName}`);
    }

    let matchedCount = 0;
    let totalCount = entry.rows.length;

    for (const row of entry.rows) {
      const variantId = skuMap.get(row.sku);

      if (!variantId) {
        unmatched.push({
          supplier: entry.supplier,
          sku: row.sku,
          product: row.product,
        });
        continue;
      }

      const cost = parseFloat(row.cost);
      if (isNaN(cost)) {
        skusSkippedNoCost++;
        continue;
      }

      const supplierCode = row.supplierCode || "";

      await prisma.supplierSku.upsert({
        where: {
          supplierId_variantId_vendorName: {
            supplierId: supplier.id,
            variantId,
            vendorName,
          },
        },
        update: {
          cost,
          supplierCode,
        },
        create: {
          shop: SHOP,
          supplierId: supplier.id,
          variantId,
          vendorName,
          supplierCode,
          cost,
        },
      });

      matchedCount++;
      skusUpserted++;
    }

    suppliersProcessed++;
    console.log(
      `${entry.supplier}: ${matchedCount}/${totalCount} matched${vendorName ? ` (vendor: ${vendorName})` : ""}`
    );
  }

  // --- Write unmatched SKUs for review ---
  fs.writeFileSync(UNMATCHED_FILE, JSON.stringify(unmatched, null, 2));

  console.log("\n--- Summary ---");
  console.log(`Suppliers processed: ${suppliersProcessed}`);
  console.log(`SupplierSku rows upserted: ${skusUpserted}`);
  console.log(`Skipped (no cost): ${skusSkippedNoCost}`);
  console.log(`Unmatched SKUs: ${unmatched.length} (written to ${UNMATCHED_FILE})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });