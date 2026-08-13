// scripts/vendor-mapping.js
//
// Terminal tool for auditing and fixing vendor -> supplier mappings.
//
// Usage:
//   node scripts/vendor-mapping.js list
//   node scripts/vendor-mapping.js suppliers
//   node scripts/vendor-mapping.js map "Vendor Name" <supplierId>
//   node scripts/vendor-mapping.js unmap "Vendor Name"
//
// Reads DATABASE_URL and SHOP from .env in the project root.

import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // strip BOM if present
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(process.cwd(), ".env"));

// Dynamic import so this runs AFTER loadEnvFile above — a normal top-level
// `import { PrismaClient } from "@prisma/client"` gets hoisted above
// everything else in the file, so PrismaClient would read process.env
// before loadEnvFile ever ran.
const { PrismaClient } = await import("@prisma/client");

const db = new PrismaClient();
const SHOP = process.env.SHOP;
const API_VERSION = "2025-01";

if (!SHOP) {
  console.error("SHOP not found — check that .env has a SHOP= line.");
  process.exit(1);
}

async function getAccessToken() {
  const session = await db.session.findFirst({ where: { shop: SHOP }, orderBy: { expires: "desc" } });
  if (!session?.accessToken) {
    throw new Error(`No session/access token found for shop ${SHOP}`);
  }
  return session.accessToken;
}

async function shopifyGraphQL(accessToken, query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchAllVendors(accessToken) {
  const vendors = new Set();
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const data = await shopifyGraphQL(accessToken, `
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { vendor } }
        }
      }
    `, { cursor });
    const conn = data.products;
    hasMore = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
    for (const e of conn.edges) {
      if (e.node.vendor?.trim()) vendors.add(e.node.vendor.trim());
    }
  }
  return [...vendors].sort((a, b) => a.localeCompare(b));
}

async function cmdList() {
  const accessToken = await getAccessToken();
  const [vendors, vendorSuppliers, suppliers] = await Promise.all([
    fetchAllVendors(accessToken),
    db.vendorSupplier.findMany({ where: { shop: SHOP } }),
    db.supplier.findMany({ where: { shop: SHOP } }),
  ]);
  const supplierNameById = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
  const mapByVendor = Object.fromEntries(vendorSuppliers.map((vs) => [vs.vendorName, vs.supplierId]));

  console.log(`\n${vendors.length} vendors found in Shopify for ${SHOP}\n`);
  let unmapped = 0;
  for (const v of vendors) {
    const supplierId = mapByVendor[v];
    if (supplierId) {
      console.log(`  ✓ ${v}  ->  ${supplierNameById[supplierId] ?? supplierId}`);
    } else {
      unmapped++;
      console.log(`  ✗ ${v}  ->  UNMAPPED`);
    }
  }
  console.log(`\n${unmapped} unmapped vendor(s).\n`);
}

async function cmdSuppliers() {
  const suppliers = await db.supplier.findMany({ where: { shop: SHOP }, orderBy: { name: "asc" } });
  console.log("");
  for (const s of suppliers) console.log(`  ${s.id}   ${s.name}`);
  console.log("");
}

async function cmdMap(vendorName, supplierId) {
  if (!vendorName || !supplierId) {
    console.error('Usage: node scripts/vendor-mapping.js map "Vendor Name" <supplierId>');
    process.exit(1);
  }
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) {
    console.error(`No supplier found with id ${supplierId}. Run "suppliers" to list valid ids.`);
    process.exit(1);
  }
  await db.vendorSupplier.deleteMany({ where: { shop: SHOP, vendorName } });
  await db.vendorSupplier.create({
    data: { shop: SHOP, vendorName, supplierId, isPrimary: true, updatedAt: new Date() },
  });
  console.log(`Mapped "${vendorName}" -> ${supplier.name}`);
}

async function cmdUnmap(vendorName) {
  if (!vendorName) {
    console.error('Usage: node scripts/vendor-mapping.js unmap "Vendor Name"');
    process.exit(1);
  }
  const { count } = await db.vendorSupplier.deleteMany({ where: { shop: SHOP, vendorName } });
  console.log(`Removed ${count} mapping(s) for "${vendorName}"`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  try {
    if (cmd === "list") await cmdList();
    else if (cmd === "suppliers") await cmdSuppliers();
    else if (cmd === "map") await cmdMap(args[0], args[1]);
    else if (cmd === "unmap") await cmdUnmap(args[0]);
    else {
      console.log(`
Usage:
  node scripts/vendor-mapping.js list
  node scripts/vendor-mapping.js suppliers
  node scripts/vendor-mapping.js map "Vendor Name" <supplierId>
  node scripts/vendor-mapping.js unmap "Vendor Name"
`);
    }
  } finally {
    await db.$disconnect();
  }
}

main();