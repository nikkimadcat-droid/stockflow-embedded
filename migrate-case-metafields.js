import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SHOP = "8a7777-3c.myshopify.com";

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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

async function main() {
  const session = await prisma.session.findFirst({ where: { shop: SHOP } });
  if (!session) {
    console.error("No session found for shop:", SHOP);
    process.exit(1);
  }
  const accessToken = session.accessToken;

  const collectionIds = [
    "gid://shopify/Collection/422532546811",
    "gid://shopify/Collection/422604570875",
    "gid://shopify/Collection/424523268347",
    "gid://shopify/Collection/424523333883",
    "gid://shopify/Collection/424523464955",
    "gid://shopify/Collection/424523530491",
    "gid://shopify/Collection/424523563259",
    "gid://shopify/Collection/424523661563",
    "gid://shopify/Collection/424523694331",
    "gid://shopify/Collection/424523792635",
    "gid://shopify/Collection/424523923707",
    "gid://shopify/Collection/424523956475",
    "gid://shopify/Collection/424524022011",
    "gid://shopify/Collection/424524087547",
    "gid://shopify/Collection/424524120315",
    "gid://shopify/Collection/424524153083",
    "gid://shopify/Collection/424524218619",
    "gid://shopify/Collection/424524251387",
    "gid://shopify/Collection/424524316923",
    "gid://shopify/Collection/424524349691",
    "gid://shopify/Collection/424524415227",
    "gid://shopify/Collection/424641069307",
    "gid://shopify/Collection/424641134843",
    "gid://shopify/Collection/424641200379",
    "gid://shopify/Collection/424641233147",
    "gid://shopify/Collection/424641265915",
    "gid://shopify/Collection/424641298683",
    "gid://shopify/Collection/424641364219",
    "gid://shopify/Collection/424641396987",
    "gid://shopify/Collection/424641429755",
    "gid://shopify/Collection/424641462523",
    "gid://shopify/Collection/424641495291",
    "gid://shopify/Collection/424641560827",
    "gid://shopify/Collection/424641626363",
    "gid://shopify/Collection/424641659131",
    "gid://shopify/Collection/424641724667",
    "gid://shopify/Collection/424641790203",
    "gid://shopify/Collection/424641855739",
    "gid://shopify/Collection/424641921275",
    "gid://shopify/Collection/424641954043",
    "gid://shopify/Collection/424642019579",
    "gid://shopify/Collection/424642117883",
    "gid://shopify/Collection/424642150651",
    "gid://shopify/Collection/424642183419",
    "gid://shopify/Collection/424642281723",
    "gid://shopify/Collection/424642347259",
    "gid://shopify/Collection/424642412795",
    "gid://shopify/Collection/424642445563",
    "gid://shopify/Collection/424642478331",
    "gid://shopify/Collection/424642576635",
    "gid://shopify/Collection/424642642171",
    "gid://shopify/Collection/424642707707",
    "gid://shopify/Collection/424642740475",
    "gid://shopify/Collection/424642806011",
    "gid://shopify/Collection/424642871547",
    "gid://shopify/Collection/424642937083",
    "gid://shopify/Collection/424643035387",
    "gid://shopify/Collection/424643199227",
    "gid://shopify/Collection/424643231995",
    "gid://shopify/Collection/424680784123",
    "gid://shopify/Collection/424680816891",
    "gid://shopify/Collection/424680882427",
    "gid://shopify/Collection/424680915195",
    "gid://shopify/Collection/424680980731",
    "gid://shopify/Collection/424681013499",
    "gid://shopify/Collection/424681079035",
    "gid://shopify/Collection/424681111803",
    "gid://shopify/Collection/424681144571",
    "gid://shopify/Collection/424681177339",
    "gid://shopify/Collection/424681242875",
    "gid://shopify/Collection/424681275643",
    "gid://shopify/Collection/424681341179",
    "gid://shopify/Collection/424681373947",
    "gid://shopify/Collection/424681439483",
    "gid://shopify/Collection/424681537787",
    "gid://shopify/Collection/426536468731",
  ];

  for (const collectionId of collectionIds) {
    let cursor = null;
    let hasMore = true;
    let collectionTitle = null;
    let caseSize = null;

    while (hasMore) {
      const res = await graphqlRequest(
        accessToken,
        `
        query($id: ID!, $cursor: String) {
          collection(id: $id) {
            title
            caseSize: metafield(namespace: "custom", key: "case_size") { value }
            products(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  variants(first: 100) {
                    edges { node { id } }
                  }
                }
              }
            }
          }
        }
      `,
        { id: collectionId, cursor }
      );

      const collection = res.data?.collection;
      if (!collection) {
        console.error("Collection not found:", collectionId);
        break;
      }

      collectionTitle = collection.title;
      caseSize = collection.caseSize?.value;

      if (!caseSize) {
        console.log(`Skipping ${collectionTitle} - no case_size set`);
        break;
      }

      const caseGroup = slugify(collectionTitle);
      const variantIds = collection.products.edges.flatMap((p) =>
        p.node.variants.edges.map((v) => v.node.id)
      );

      for (let i = 0; i < variantIds.length; i += 12) {
        const batch = variantIds.slice(i, i + 12);
        const metafieldsInput = batch.flatMap((variantId) => [
          {
            ownerId: variantId,
            namespace: "custom",
            key: "case_size",
            type: "number_integer",
            value: caseSize,
          },
          {
            ownerId: variantId,
            namespace: "custom",
            key: "case_group",
            type: "single_line_text_field",
            value: caseGroup,
          },
        ]);

        const setRes = await graphqlRequest(
          accessToken,
          `
          mutation($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id }
              userErrors { field message }
            }
          }
        `,
          { metafields: metafieldsInput }
        );

        const errors = setRes.data?.metafieldsSet?.userErrors ?? [];
        if (errors.length > 0) {
          console.error(`Errors for ${collectionTitle}:`, errors);
        } else {
          console.log(
            `Tagged ${batch.length} variants in "${collectionTitle}" (case_size=${caseSize}, case_group=${caseGroup})`
          );
        }
      }

      hasMore = collection.products.pageInfo.hasNextPage;
      cursor = collection.products.pageInfo.endCursor;
    }
  }

  console.log("Migration complete.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


