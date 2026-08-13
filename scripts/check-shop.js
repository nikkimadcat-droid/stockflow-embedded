import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
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
    process.env[key] = value;
  }
}

loadEnvFile(path.join(process.cwd(), ".env"));

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

const sessions = await db.session.findMany({ select: { shop: true } });
console.log("Shops found in Session table:");
for (const s of sessions) console.log(`  "${s.shop}"`);

const suppliers = await db.supplier.findMany({ select: { shop: true, name: true } });
console.log("\nShops found in Supplier table:");
for (const s of suppliers) console.log(`  "${s.shop}"  (${s.name})`);

await db.$disconnect();