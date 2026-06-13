import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

let prisma = new PrismaClient();

const SHOP = "8a7777-3c.myshopify.com";

const LOCATION_FILES = {
  477478: "./data/stocky-minmax-mineralpoint.json",
  477479: "./data/stocky-minmax-monroe.json",
  477480: "./data/stocky-minmax-willy.json",
};

const API_VERSION = "2025-10";

async function getOfflineAccessToken(shop) {
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session) {
    throw new Error(`No offline session found for shop ${shop}`);
  }
  return session.accessToken;
}

async function fetchAllVariants(shop, accessToken) {
  const skuToVariantId = new Map();
  let cursor = null;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore) {
    const query = `
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              variants(first: 100) {
                edges { node { id sku } }
              }
            }
          }
        }
      }
    `;

    const res = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: { cursor } }),
      }
    );

    const json = await res.json();
    if (json.errors) {
      throw new Error(`Shopify API error: ${JSON.stringify(json.errors)}`);
    }

    const page = json.data.products;
    for (const { node: p } of page.edges) {
      for (const { node: v } of p.variants.edges) {
        if (v.sku) {
          skuToVariantId.set(v.sku.trim(), v.id);
        }
      }
    }

    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
    pageCount++;
    console.log(`Fetched product page ${pageCount}, variants so far: ${skuToVariantId.size}`);
  }

  return skuToVariantId;
}

async function upsertWithRetry(args, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await prisma.minMax.upsert(args);
    } catch (err) {
      console.warn(`  upsert failed (attempt ${i + 1}): ${err.code || err.message}, reconnecting...`);
      try { await prisma.$disconnect(); } catch {}
      prisma = new PrismaClient();
      await prisma.$connect();
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error("upsert failed after retries");
}

async function importLocation(locationNumericId, filePath, skuToVariantId, shop) {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`File not found, skipping: ${fullPath}`);
    return;
  }

  const rows = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  const locationGid = `gid://shopify/Location/${locationNumericId}`;

  let upserted = 0;
  let skippedNoMinMax = 0;
  let skippedNoMatch = 0;
  const unmatched = [];

  for (const row of rows) {
    const min = row.min === "" ? null : parseInt(row.min, 10);
    const max = row.max === "" ? null : parseInt(row.max, 10);

    if (min === null && max === null) {
      skippedNoMinMax++;
      continue;
    }

    const variantId = skuToVariantId.get(row.sku.trim());
    if (!variantId) {
      skippedNoMatch++;
      unmatched.push(row.sku);
      continue;
    }

    await upsertWithRetry({
      where: {
        shop_variantId_locationId: {
          shop,
          variantId,
          locationId: locationGid,
        },
      },
      update: {
        minLevel: min ?? 0,
        maxLevel: max ?? 0,
      },
      create: {
        shop,
        variantId,
        locationId: locationGid,
        minLevel: min ?? 0,
        maxLevel: max ?? 0,
        casePackSize: 1,
      },
    });

    upserted++;
    if (upserted % 100 === 0) {
      console.log(`  [${locationNumericId}] upserted ${upserted}...`);
    }
    if (upserted % 500 === 0) {
      try { await prisma.$disconnect(); } catch {}
      prisma = new PrismaClient();
      await prisma.$connect();
    }
  }

  console.log(`Location ${locationNumericId}: upserted=${upserted}, skippedNoMinMax=${skippedNoMinMax}, skippedNoMatch=${skippedNoMatch}`);
  if (unmatched.length > 0) {
    const outFile = `./data/unmatched-${locationNumericId}.json`;
    fs.writeFileSync(outFile, JSON.stringify(unmatched, null, 2));
    console.log(`  Unmatched SKUs written to ${outFile}`);
  }
}

async function main() {
  console.log("Fetching offline access token...");
  const accessToken = await getOfflineAccessToken(SHOP);

  console.log("Fetching all variants from Shopify (this may take a bit)...");
  const skuToVariantId = await fetchAllVariants(SHOP, accessToken);
  console.log(`Total SKU -> variantId mappings: ${skuToVariantId.size}`);

  for (const [locationId, filePath] of Object.entries(LOCATION_FILES)) {
    console.log(`\n--- Importing location ${locationId} from ${filePath} ---`);
    await importLocation(locationId, filePath, skuToVariantId, SHOP);
  }

  await prisma.$disconnect();
  console.log("\nDone.");
}

main().catch(async (err) => {
  console.error(err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
