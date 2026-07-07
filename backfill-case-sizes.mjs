// backfill-case-sizes.mjs
//
// One-off script to fix case pack sizes that were set at ONE location
// (e.g. Mineral Point Road) but never propagated to the others, because
// the old save handler used updateMany, which silently skips locations
// that never had a MinMax row created yet.
//
// This script finds every variant that has a non-default casePackSize
// set anywhere, and copies that value to every other location's MinMax
// row for the same variant — creating the row if it doesn't exist yet.
// It does NOT touch minLevel/maxLevel on rows it creates or updates
// (those stay per-location, defaulting to 0 on create).
//
// USAGE:
//   node backfill-case-sizes.mjs --dry-run     (preview only, no writes)
//   node backfill-case-sizes.mjs               (actually applies changes)

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const SHOP = "8a7777-3c.myshopify.com"; // update if needed
const DEFAULT_CASE_PACK = 1; // treat this as "unset"
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`Running backfill for shop: ${SHOP}`);
  console.log(DRY_RUN ? "DRY RUN — no writes will be made\n" : "LIVE RUN — changes will be written\n");

  const locationRows = await prisma.minMax.findMany({
    where: { shop: SHOP },
    select: { locationId: true },
    distinct: ["locationId"],
  });
  const allLocationIds = locationRows.map(r => r.locationId);
  console.log(`Found ${allLocationIds.length} location(s) in MinMax data:`, allLocationIds);

  const casedRows = await prisma.minMax.findMany({
    where: { shop: SHOP, casePackSize: { not: DEFAULT_CASE_PACK } },
    orderBy: { updatedAt: "desc" },
  });

  const byVariant = new Map();
  for (const row of casedRows) {
    if (!byVariant.has(row.variantId)) {
      byVariant.set(row.variantId, []);
    }
    byVariant.get(row.variantId).push(row);
  }

  console.log(`\nFound ${byVariant.size} variant(s) with a case size set at one or more locations.\n`);

  let createCount = 0;
  let updateCount = 0;
  let conflictCount = 0;

  for (const [variantId, rows] of byVariant.entries()) {
    const distinctValues = new Set(rows.map(r => r.casePackSize));
    if (distinctValues.size > 1) {
      conflictCount++;
      console.warn(
        `??  CONFLICT variant ${variantId}: different case sizes at different locations (${
          rows.map(r => `${r.locationId}=${r.casePackSize}`).join(", ")
        }). Using most recently updated: ${rows[0].casePackSize} (from ${rows[0].locationId}, updated ${rows[0].updatedAt.toISOString()})`
      );
    }

    const sourceCasePackSize = rows[0].casePackSize;
    const locationsWithValue = new Set(rows.map(r => r.locationId));
    const targetLocationIds = allLocationIds.filter(id => !locationsWithValue.has(id));

    for (const locationId of targetLocationIds) {
      const existing = await prisma.minMax.findUnique({
        where: { shop_variantId_locationId: { shop: SHOP, variantId, locationId } },
      });

      if (existing) {
        console.log(`  UPDATE variant ${variantId} @ ${locationId}: casePackSize ${existing.casePackSize} -> ${sourceCasePackSize}`);
        updateCount++;
        if (!DRY_RUN) {
          await prisma.minMax.update({
            where: { shop_variantId_locationId: { shop: SHOP, variantId, locationId } },
            data: { casePackSize: sourceCasePackSize },
          });
        }
      } else {
        console.log(`  CREATE variant ${variantId} @ ${locationId}: casePackSize ${sourceCasePackSize} (minLevel/maxLevel default to 0)`);
        createCount++;
        if (!DRY_RUN) {
          await prisma.minMax.create({
            data: {
              shop: SHOP,
              variantId,
              locationId,
              minLevel: 0,
              maxLevel: 0,
              casePackSize: sourceCasePackSize,
            },
          });
        }
      }
    }
  }

  console.log(`\nDone.`);
  console.log(`  Rows to create: ${createCount}`);
  console.log(`  Rows to update: ${updateCount}`);
  console.log(`  Variants with conflicting values across locations: ${conflictCount}`);
  if (DRY_RUN) {
    console.log(`\nThis was a dry run — nothing was written. Re-run without --dry-run to apply.`);
  }
}

main()
  .catch(e => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
