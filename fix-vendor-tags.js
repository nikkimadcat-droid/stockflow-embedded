import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SHOP = "8a7777-3c.myshopify.com";

async function graphqlRequest(accessToken, query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
  }
  return json;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const session = await prisma.session.findFirst({ where: { shop: SHOP } });
  if (!session) {
    console.error("No session found for shop:", SHOP);
    process.exit(1);
  }
  const accessToken = session.accessToken;

  const orphaned = await prisma.supplierSku.findMany({
    where: {
      shop: SHOP,
      vendorName: "",
    },
  });

  console.log(`Found ${orphaned.length} SKUs with missing vendorName.`);

  if (orphaned.length === 0) {
    console.log("Nothing to fix.");
    await prisma.$disconnect();
    return;
  }

  const uniqueVariantIds = [...new Set(orphaned.map((s) => s.variantId))];

  const variantVendorMap = {};
  for (const batch of chunk(uniqueVariantIds, 50)) {
    const res = await graphqlRequest(
      accessToken,
      `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            product { vendor }
          }
        }
      }
    `,
      { ids: batch }
    );

    for (const node of res.data?.nodes ?? []) {
      if (node?.id && node?.product?.vendor) {
        variantVendorMap[node.id] = node.product.vendor;
      }
    }
  }

  let fixed = 0;
  let stillMissing = 0;
  let duplicatesRemoved = 0;
  const touchedVendorSupplierPairs = new Set();

  for (const sku of orphaned) {
    const vendor = variantVendorMap[sku.variantId];
    if (!vendor) {
      console.log(`No current vendor found on Shopify for variant ${sku.variantId} (SKU row ${sku.id}) - left as-is`);
      stillMissing++;
      continue;
    }

    try {
      await prisma.supplierSku.update({
        where: { id: sku.id },
        data: { vendorName: vendor },
      });
      fixed++;
    } catch (err) {
      if (err.code === "P2002") {
        await prisma.supplierSku.delete({ where: { id: sku.id } });
        duplicatesRemoved++;
        console.log(`Removed duplicate blank row for variant ${sku.variantId} (already correctly tagged elsewhere)`);
        continue;
      }
      throw err;
    }

    const pairKey = `${vendor}::${sku.supplierId}`;
    if (!touchedVendorSupplierPairs.has(pairKey)) {
      touchedVendorSupplierPairs.add(pairKey);
      await prisma.vendorSupplier.upsert({
        where: {
          shop_vendorName_supplierId: {
            shop: SHOP,
            vendorName: vendor,
            supplierId: sku.supplierId,
          },
        },
        update: {},
        create: {
          shop: SHOP,
          vendorName: vendor,
          supplierId: sku.supplierId,
          isPrimary: true,
        },
      });
    }
  }

  console.log(`Fixed ${fixed} SKUs.`);
  if (duplicatesRemoved > 0) {
    console.log(`Removed ${duplicatesRemoved} stale duplicate rows (already correctly tagged elsewhere).`);
  }
  if (stillMissing > 0) {
    console.log(`${stillMissing} SKUs could not be matched (variant may have been deleted in Shopify).`);
  }
  console.log("Done.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});