import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient();

const session = await prisma.session.findFirst({ where: { isOnline: false }, orderBy: { expires: "desc" } });

const res = await fetch(`https://${session.shop}/admin/api/2025-10/graphql.json`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
  body: JSON.stringify({ query: `{ locations(first: 10) { edges { node { id name } } } }` }),
});
const json = await res.json();
console.log(json.data.locations.edges.map(e => e.node));

await prisma.$disconnect();
