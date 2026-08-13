import dotenv from "dotenv";
dotenv.config();

import prisma from "../db.server.js";

const SHOP = "8a7777-3c.myshopify.com";
const WILLY_LOCATION_GID = "gid://shopify/Location/75811291387";

const scrapedRows = [
  { rowText: ["WeruvaCase - Funky Chunky - 5oz","Default Title","M26846","","PFX","-","-","0","",""], inputValues: ["2","3"] },
  { rowText: ["WeruvaCase - Funky Chunky - 5oz","Default Title","M26846","878408000232","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Kitten - Chx 3oz (pink)","Default Title","M20896","810028242777","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Kitten - Chx au jus 3oz (yellow)","Default Title","M20894","810028242739","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Kitten - Chx/pump 3oz (blue)","Default Title","M20895","810028242746","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Kitten - Chx/tuna 3oz (green)","Default Title","M20893","810028242753","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Kitten - tuna/sal 3oz (orange)","Default Title","M20892","810028242760","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Mack&Jack - 5.5oz","Default Title","M20944","878408000041","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Mack&Jack - 5.5oz","Default Title","M20944","","PFX","-","-","0","",""], inputValues: ["2","3"] },
  { rowText: ["WeruvaCase - Mideast Feast - 5.5oz","Default Title","M20945","","PFX","-","-","0","",""], inputValues: ["3","5"] },
  { rowText: ["WeruvaCase - Mideast Feast - 5.5oz","Default Title","M20945","878408000072","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Jolly Good - 3oz","Default Title","M20937","","PFX","-","-","0","",""], inputValues: ["3","5"] },
  { rowText: ["WeruvaCase - Pate - Jolly Good - 3oz","Default Title","M20937","813778018449","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Meal or No - 3oz (purp)","Default Title","M20934","","PFX","-","-","0","",""], inputValues: ["2","3"] },
  { rowText: ["WeruvaCase - Pate - Meal or No - 3oz (purp)","Default Title","M20934","813778018432","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Meowionaire - 3oz","Default Title","M20938","","PFX","-","-","0","",""], inputValues: ["3","5"] },
  { rowText: ["WeruvaCase - Pate - Meowionaire - 3oz","Default Title","M20938","813778018425","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Press dinner - 3oz (yellow)","Default Title","M20940","","PFX","-","-","0","",""], inputValues: ["4","8"] },
  { rowText: ["WeruvaCase - Pate - Press dinner - 3oz (yellow)","Default Title","M20940","810028241435","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Press lunch - 3oz (blue)","Default Title","M20939","","PFX","-","-","0","",""], inputValues: ["4","8"] },
  { rowText: ["WeruvaCase - Pate - Press lunch - 3oz (blue)","Default Title","M20939","813778018463","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Purramid - 3oz (mint)","Default Title","M20935","","PFX","-","-","0","",""], inputValues: ["2","3"] },
  { rowText: ["WeruvaCase - Pate - Purramid - 3oz (mint)","Default Title","M20935","813778018456","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Tic Tac - 3oz (magenta)","Default Title","M20936","813778018418","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pate - Tic Tac - 3oz (magenta)","Default Title","M20936","","PFX","-","-","0","",""], inputValues: ["3","5"] },
  { rowText: ["WeruvaCase - Paw Lick'n - 5.5oz","Default Title","M20946","878408000218","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Paw Lick'n - 5.5oz","Default Title","M20946","","PFX","-","-","0","",""], inputValues: ["5","12"] },
  { rowText: ["WeruvaCase - Poly BBQ - 5.5oz","Default Title","M20943","","PFX","-","-","0","",""], inputValues: ["2","3"] },
  { rowText: ["WeruvaCase - Poly BBQ - 5.5oz","Default Title","M20943","878408000089","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Pumpkin Patch Up - 2.8oz","Default Title","M27051","878408000713","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx gravy 3oz (yellow)","Default Title","M27445","810028246362","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx gravy 5oz (yellow)","Default Title","M27440","810028246485","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx puree 3oz (green)","Default Title","M27499","810028246355","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx puree 3oz (green)","Default Title","M27499","810028246355","PFX","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx puree 3oz (green)","Default Title","M27432","810028246355","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx puree 5oz (green)","Default Title","M27435","810028246478","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx/tuna 3oz (blue)","Default Title","M27447","810028246386","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - chx/tuna 5oz (blue)","Default Title","","","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - tuna/sal 3oz (pink)","Default Title","M27446","810028246379","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Senior - tuna/sal 5oz (pink)","Default Title","M27443","810028246492","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Slide - Breafast","Default Title","M20922","","Weruva","-","-","0","",""], inputValues: ["0","0"] },
  { rowText: ["WeruvaCase - Slide - Jeopurrdy (blue)","Default Title","M20926","","PFX","-","-","0","",""], inputValues: ["3","6"] },
  { rowText: ["WeruvaCase - Slide - Jeopurrdy (blue)","Default Title","M20926","813778018913","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Slide - Love Connecion (org)","Default Title","M20925","","PFX","-","-","0","",""], inputValues: ["3","6"] },
  { rowText: ["WeruvaCase - Slide - Love Connection (org)","Default Title","M20925","813778018906","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Slide - Newly Fed - (purp)","Default Title","M20924","813778018883","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Slide - Newly Fed - (purp)","Default Title","M20924","","PFX","-","-","0","",""], inputValues: ["2","5"] },
  { rowText: ["WeruvaCase - Slide - Slice Right (yel)","Default Title","M20923","813778018852","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Slide - Slice Right (yel)","Default Title","M20923","","PFX","-","-","0","",""], inputValues: ["3","6"] },
  { rowText: ["WeruvaCase - WX - chx gravy (yellow)","Default Title","M20901","810028242593","Weruva","-","-","0","",""], inputValues: ["",""] },
];

async function main() {
  const bySku = new Map();
  const skippedNoSku = [];

  for (const row of scrapedRows) {
    const sku = (row.rowText[2] || "").trim();
    const [minRaw, maxRaw] = row.inputValues;
    const hasValues = minRaw !== "" || maxRaw !== "";

    if (!sku) {
      skippedNoSku.push(row.rowText[0]);
      continue;
    }

    const existing = bySku.get(sku);
    if (!existing) {
      bySku.set(sku, { sku, productTitle: row.rowText[0], minRaw, maxRaw, hasValues });
    } else if (!existing.hasValues && hasValues) {
      bySku.set(sku, { sku, productTitle: row.rowText[0], minRaw, maxRaw, hasValues });
    }
  }

  const toWrite = [...bySku.values()].filter(r => r.hasValues);
  const stillBlank = [...bySku.values()].filter(r => !r.hasValues);

  console.log(`Deduped to ${bySku.size} unique SKUs.`);
  console.log("--- Values that WILL be written ---");
  for (const r of toWrite) {
    console.log(`  ${r.sku}  (${r.productTitle})  ->  min ${r.minRaw || 0} / max ${r.maxRaw || 0}`);
  }
  if (stillBlank.length) {
    console.log("--- SKUs with NO value in either Stocky row (will be skipped, not zeroed) ---");
    stillBlank.forEach(r => console.log(`  ${r.sku}  (${r.productTitle})`));
  }
  if (skippedNoSku.length) {
    console.log("--- Rows skipped, no SKU at all ---");
    skippedNoSku.forEach(t => console.log(`  ${t}`));
  }

  if (toWrite.length === 0) {
    console.log("Nothing to write. Exiting.");
    return;
  }

  const session = await prisma.session.findFirst({
    where: { shop: SHOP, isOnline: false },
  });
  if (!session?.accessToken) {
    console.error("No offline session token found for shop. Visit the app in Shopify admin first to refresh it.");
    return;
  }

  const skuToVariantId = {};
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({
        query: `
          query($cursor: String) {
            productVariants(first: 250, after: $cursor, query: "vendor:'Weruva'") {
              pageInfo { hasNextPage endCursor }
              edges { node { id sku } }
            }
          }
        `,
        variables: { cursor },
      }),
    });
    const json = await res.json();
    const page = json.data?.productVariants;
    if (!page) {
      console.error("GraphQL error:", JSON.stringify(json, null, 2));
      break;
    }
    for (const { node: v } of page.edges) {
      if (v.sku) skuToVariantId[v.sku.trim()] = v.id;
    }
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  console.log(`Mapped ${Object.keys(skuToVariantId).length} Weruva variant IDs from Shopify.`);

  let updated = 0;
  let created = 0;
  const unmatched = [];

  for (const row of toWrite) {
    const variantId = skuToVariantId[row.sku];
    if (!variantId) {
      unmatched.push(row.sku);
      continue;
    }
    const minLevel = Number(row.minRaw) || 0;
    const maxLevel = Number(row.maxRaw) || 0;

    const existing = await prisma.minMax.findFirst({
      where: { shop: SHOP, variantId, locationId: WILLY_LOCATION_GID },
    });

    if (existing) {
      await prisma.minMax.update({
        where: { id: existing.id },
        data: { minLevel, maxLevel, updatedAt: new Date() },
      });
      updated++;
    } else {
      await prisma.minMax.create({
        data: {
          shop: SHOP,
          variantId,
          locationId: WILLY_LOCATION_GID,
          minLevel,
          maxLevel,
          updatedAt: new Date(),
        },
      });
      created++;
    }
  }

  console.log(`Done. Updated: ${updated}, Created: ${created}`);
  if (unmatched.length) console.log(`Unmatched SKUs (no variant found in Shopify):`, unmatched);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
