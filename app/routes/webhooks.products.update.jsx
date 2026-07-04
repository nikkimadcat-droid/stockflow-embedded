import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const vendorName = payload.vendor || "";
    const variants = payload.variants || [];

    if (!vendorName || variants.length === 0) {
      return new Response();
    }

    const vendorSupplier = await db.vendorSupplier.findFirst({
      where: { shop, vendorName, isPrimary: true },
    });

    if (!vendorSupplier) {
      return new Response();
    }

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
  } catch (err) {
    console.error("PRODUCTS/UPDATE WEBHOOK FAILED:", err);
  }

  return new Response();
};
