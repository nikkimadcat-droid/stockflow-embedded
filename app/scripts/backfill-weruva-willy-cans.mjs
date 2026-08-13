import dotenv from "dotenv";
dotenv.config();

import prisma from "../db.server.js";

const SHOP = "8a7777-3c.myshopify.com";
const WILLY_LOCATION_GID = "gid://shopify/Location/75811291387";

const scrapedRows = [
  { rowText: ["CIK - Goldie Lox - 3oz (gold)","Default Title","M27712","878408008290","Weruva","-","-","26","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Goldie Lox - 6oz (gold)","Default Title","M27715","878408008733","Weruva","-","-","45","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Kitty Gone Wild - 3oz (pink)","Default Title","M27865","878408008306","Weruva","-","-","16","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Kitty Gone Wild - 6oz (pink)","Default Title","M27864","878408008740","Weruva","-","-","26","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - La Isla Bonita - 3oz (purple)","Default Title","M27711","878408008283","Weruva","-","-","59","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - La Isla Bonita - 6oz (purple)","Default Title","M27716","878408008726","Weruva","-","-","47","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Lamb Burgerini - 3oz (green)","Default Title","M27709","878408008702","Weruva","-","-","17","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Lamb Burgerini - 6oz (green)","Default Title","M27710","878408008788","Weruva","-","-","30","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Two Tu Tango - 3oz (red)","Default Title","M27713","878408008276","Weruva","-","-","17","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Two Tu Tango - 6oz (red)","Default Title","M27714","878408008719","Weruva","-","-","41","",""], inputValues: ["6","48"] },
  { rowText: ["CIK pouch - Chick Magnet (green)","Default Title","M16513","878408008221","Weruva","-","-","45","",""], inputValues: ["12","36"] },
  { rowText: ["CIK pouch - Love Me Tender (purple)","Default Title","M16510","878408008238","Weruva","-","-","48","",""], inputValues: ["24","72"] },
  { rowText: ["CIK pouch - Mack Jack Sam (red)","Default Title","M16509","878408008269","Weruva","-","-","44","",""], inputValues: ["24","72"] },
  { rowText: ["CIK pouch - One if By Land (blue)","Default Title","M16511","878408008252","Weruva","-","-","40","",""], inputValues: ["24","72"] },
  { rowText: ["CIK pouch - Pumpkin Jack Splash (orange)","Default Title","M15135","878408008245","Weruva","-","-","34","",""], inputValues: ["36","84"] },
  { rowText: ["CIK pouch - Pumpkin Lick'n Chicken (yellow)","Default Title","M16512","878408008214","Weruva","-","-","58","",""], inputValues: ["24","72"] },
  { rowText: ["CIKCase - chicken Frick'A Zee - 3oz","Default Title","","878408009020","Weruva","-","-","0","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Double Dip - 2.8oz (red)","Default Title","M16583","878408004728","Weruva","-","-","56","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Fowl Ball - 2.8oz (pink)","Default Title","M16580","878408004681","Weruva","-","-","26","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Funk in the Trunk -  2.8oz (teal)","Default Title","M16581","878408004698","Weruva","-","-","36","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Lamburgini - 2.8oz (green)","Default Title","M16582","878408004711","Weruva","-","-","40","",""], inputValues: ["0","0"] },
  { rowText: ["DITKCase - Double Dip (red)","Default Title","M27156","878408004667","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["DITKCase - Double Dip (red)","Default Title","M27156","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Fowl Ball (pink)","Default Title","M27153","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Fowl Ball (pink)","Default Title","M27153","878408004629","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["DITKCase - Funk in the Trunk (teal)","Default Title","M27154","878408004636","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["DITKCase - Funk in the Trunk (teal)","Default Title","M27154","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Lamburgini (green)","Default Title","M27155","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Lamburgini (green)","Default Title","M27155","878408004650","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WERCase - CIK - chick magnet (green)","Default Title","M20916","","Weruva","-","-","","",""], inputValues: ["2","3"] },
  { rowText: ["WERCase - CIK - Love me (purp)","Default Title","M20919","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - mack jack (red)","Default Title","M20918","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - One if by land (blue)","Default Title","M20917","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - Pumpkin Jack (org)","Default Title","M20920","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - Pumpkin Lick (yel)","Default Title","M20921","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["Weruva - Dog - Bed+Bfast - 14oz","Default Title","M15427","878408005220","Weruva","-","-","2","",""], inputValues: ["12","24"] },
  { rowText: ["Weruva - Dog - Cirque De La Mer - 14oz","Default Title","M16587","878408005107","Weruva","-","-","8","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Funky Chunky - 14oz","Default Title","M15424","878408005138","Weruva","-","-","0","",""], inputValues: ["24","36"] },
  { rowText: ["Weruva - Dog - Hot Dayam - 14oz","Default Title","M15422","878408004605","Weruva","-","-","19","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Jammin Salmon - 14oz","Default Title","M16584","878408005190","Weruva","-","-","11","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Marbella Paella - 14oz","Default Title","M16586","878408005213","Weruva","-","-","2","",""], inputValues: ["0","0"] },
  { rowText: ["Weruva - Dog - Paw Licken - 14oz","Default Title","M15423","878408005114","Weruva","-","-","17","",""], inputValues: ["24","36"] },
  { rowText: ["Weruva - Dog - Paw Lickin' Chicken - 5.5oz","Default Title","M14730","878408003110","Weruva","-","-","27","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Dog - Peking Ducken - 14oz","Default Title","M16585","878408004582","Weruva","-","-","11","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Steak Frites - 14oz","Default Title","M15426","878408005183","Weruva","-","-","11","",""], inputValues: ["12","24"] },
  { rowText: ["Weruva - Dog - Steak Frites - 5.5oz","Default Title","M14729","878408003189","Weruva","-","-","25","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Dog - Wok the dog - 14oz","Default Title","M20290","878408005176","Weruva","-","-","4","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Dog - Wok The Dog - 5.5oz","Default Title","M14731","878408003172","Weruva","-","-","37","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Kitten - Chx 3oz (pink)","Default Title","M16548","810028242821","Weruva","-","-","80","",""], inputValues: ["48","144"] },
  { rowText: ["Weruva - Kitten - Chx 3oz (yel)","Default Title","M16550","810028242784","Weruva","-","-","74","",""], inputValues: ["48","144"] },
];

async function main() {
  const bySku = new Map();
  const skippedNoSku = [];

  for (const row of scrapedRows) {
    const sku = (row.rowText[2] || "").trim();
    const [minRaw, maxRaw] = row.inputValues;
    const hasValues = minRaw !== "" || maxRaw !== "";

    if (!sku) { skippedNoSku.push(row.rowText[0]); continue; }

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
    console.log("--- SKUs with NO value in either Stocky row ---");
    stillBlank.forEach(r => console.log(`  ${r.sku}  (${r.productTitle})`));
  }
  if (skippedNoSku.length) {
    console.log("--- Rows skipped, no SKU at all ---");
    skippedNoSku.forEach(t => console.log(`  ${t}`));
  }

  if (toWrite.length === 0) { console.log("Nothing to write. Exiting."); return; }

  const session = await prisma.session.findFirst({ where: { shop: SHOP, isOnline: false } });
  if (!session?.accessToken) {
    console.error("No offline session token found. Visit the app in Shopify admin first to refresh it.");
    return;
  }

  const skuToVariantId = {};
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
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
    if (!page) { console.error("GraphQL error:", JSON.stringify(json, null, 2)); break; }
    for (const { node: v } of page.edges) { if (v.sku) skuToVariantId[v.sku.trim()] = v.id; }
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  console.log(`Mapped ${Object.keys(skuToVariantId).length} Weruva variant IDs from Shopify.`);

  let updated = 0, created = 0;
  const unmatched = [];

  for (const row of toWrite) {
    const variantId = skuToVariantId[row.sku];
    if (!variantId) { unmatched.push(row.sku); continue; }
    const minLevel = Number(row.minRaw) || 0;
    const maxLevel = Number(row.maxRaw) || 0;

    const existing = await prisma.minMax.findFirst({ where: { shop: SHOP, variantId, locationId: WILLY_LOCATION_GID } });
    if (existing) {
      await prisma.minMax.update({ where: { id: existing.id }, data: { minLevel, maxLevel, updatedAt: new Date() } });
      updated++;
    } else {
      await prisma.minMax.create({ data: { shop: SHOP, variantId, locationId: WILLY_LOCATION_GID, minLevel, maxLevel, updatedAt: new Date() } });
      created++;
    }
  }

  console.log(`Done. Updated: ${updated}, Created: ${created}`);
  if (unmatched.length) console.log(`Unmatched SKUs (no variant found in Shopify):`, unmatched);
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
