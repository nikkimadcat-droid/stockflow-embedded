import { authenticate } from "../shopify.server";
import db from "../db.server";

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const vendorName = payload.vendor || "";
    const variants = payload.variants || [];

    // --- Existing logic: auto-link to a supplier via VendorSupplier mapping ---
    if (vendorName && variants.length > 0) {
      const vendorSupplier = await db.vendorSupplier.findFirst({
        where: { shop, vendorName, isPrimary: true },
      });

      if (vendorSupplier) {
        for (const variant of variants) {
          const variantId = `gid://shopify/ProductVariant/${variant.id}`;
          await db.supplierSku.upsert({
            where: {
              supplierId_variantId_vendorName: {
                supplierId: vendorSupplier.supplierId,
                variantId,
                vendorName,
              },
            },
            update: {},
            create: {
              shop,
              supplierId: vendorSupplier.supplierId,
              variantId,
              supplierCode: "",
              vendorName,
              cost: 0,
            },
          });
        }
      }
    }

    // --- New logic: auto-tag case_size/case_group from collection membership ---
    if (admin && payload.id) {
      const productGid = `gid://shopify/Product/${payload.id}`;

      const res = await admin.graphql(
        `
        query($id: ID!) {
          product(id: $id) {
            collections(first: 10) {
              nodes {
                title
                caseSize: metafield(namespace: "custom", key: "case_size") { value }
              }
            }
            variants(first: 100) {
              edges { node { id } }
            }
          }
        }
      `,
        { variables: { id: productGid } }
      );

      const json = await res.json();
      const product = json.data?.product;

      if (product) {
        const collections = product.collections?.nodes ?? [];
        const eligibleCollection = collections.find((c) => {
          const size = parseInt(c.caseSize?.value, 10);
          return size > 0;
        });

        if (eligibleCollection) {
          const caseSize = parseInt(eligibleCollection.caseSize.value, 10);
          const caseGroup = slugify(eligibleCollection.title);
          const variantIds = product.variants.edges.map((e) => e.node.id);

          for (let i = 0; i < variantIds.length; i += 12) {
            const batch = variantIds.slice(i, i + 12);
            const metafieldsInput = batch.flatMap((variantId) => [
              {
                ownerId: variantId,
                namespace: "custom",
                key: "case_size",
                type: "number_integer",
                value: String(caseSize),
              },
              {
                ownerId: variantId,
                namespace: "custom",
                key: "case_group",
                type: "single_line_text_field",
                value: caseGroup,
              },
            ]);

            const setRes = await admin.graphql(
              `
              mutation($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                  metafields { id }
                  userErrors { field message }
                }
              }
            `,
              { variables: { metafields: metafieldsInput } }
            );

            const setJson = await setRes.json();
            const errors = setJson.data?.metafieldsSet?.userErrors ?? [];
            if (errors.length > 0) {
              console.error(`Case-size tagging errors for product ${payload.id}:`, errors);
            } else {
              console.log(
                `Tagged ${batch.length} variants on product ${payload.id} (case_size=${caseSize}, case_group=${caseGroup})`
              );
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("PRODUCTS/UPDATE WEBHOOK FAILED:", err);
  }

  return new Response();
};
