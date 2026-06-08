import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  Select,
  TextField,
  Banner,
  Badge,
  InlineStack,
  EmptyState,
} from "@shopify/polaris";
import { useState } from "react";

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const { id } = params;

  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: { skus: true },
  });

  if (!supplier) throw new Response("Not found", { status: 404 });

  // Get all Shopify vendors
  const vendorResponse = await admin.graphql(`
    query {
      products(first: 250) {
        edges {
          node {
            vendor
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  displayName
                }
              }
            }
          }
        }
      }
    }
  `);
  const vendorData = await vendorResponse.json();
  const products = vendorData.data.products.edges.map(e => e.node);

  const vendorMap = {};
  for (const p of products) {
    if (!p.vendor) continue;
    if (!vendorMap[p.vendor]) vendorMap[p.vendor] = [];
    for (const { node: v } of p.variants.edges) {
      vendorMap[p.vendor].push({ id: v.id, sku: v.sku, name: v.displayName });
    }
  }

  const linkedSkuIds = new Set(supplier.skus.map(s => s.variantId));

  return { supplier, vendorMap, linkedSkuIds: [...linkedSkuIds], shop };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const { id: supplierId } = params;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "add_by_vendor") {
    const vendor = formData.get("vendor");
    const cost = parseFloat(formData.get("cost")) || 0;
    const variants = JSON.parse(formData.get("variants"));

    for (const v of variants) {
      await prisma.supplierSku.upsert({
        where: { supplierId_variantId: { supplierId, variantId: v.id } },
        update: { cost, supplierCode: v.sku || "" },
        create: {
          shop,
          supplierId,
          variantId: v.id,
          supplierCode: v.sku || "",
          cost,
        },
      });
    }
    return { ok: true };
  }

  if (intent === "add_sku") {
    const variantId = formData.get("variantId");
    const supplierCode = formData.get("supplierCode");
    const cost = parseFloat(formData.get("cost")) || 0;

    await prisma.supplierSku.upsert({
      where: { supplierId_variantId: { supplierId, variantId } },
      update: { cost, supplierCode },
      create: { shop, supplierId, variantId, supplierCode, cost },
    });
    return { ok: true };
  }

  if (intent === "remove_sku") {
    const variantId = formData.get("variantId");
    await prisma.supplierSku.deleteMany({
      where: { supplierId, variantId },
    });
    return { ok: true };
  }

  return { ok: false };
};

export default function SupplierDetail() {
  const { supplier, vendorMap, linkedSkuIds } = useLoaderData();
  const fetcher = useFetcher();

  const [selectedVendor, setSelectedVendor] = useState("");
  const [vendorCost, setVendorCost] = useState("");

  const vendors = Object.keys(vendorMap).sort();
  const vendorOptions = [
    { label: "Select a vendor...", value: "" },
    ...vendors.map(v => ({ label: v, value: v })),
  ];

  const handleAddByVendor = () => {
    if (!selectedVendor) return;
    const variants = vendorMap[selectedVendor] ?? [];
    const form = new FormData();
    form.append("intent", "add_by_vendor");
    form.append("vendor", selectedVendor);
    form.append("cost", vendorCost);
    form.append("variants", JSON.stringify(variants));
    fetcher.submit(form, { method: "POST" });
    setSelectedVendor("");
    setVendorCost("");
  };

  const handleRemove = (variantId) => {
    const form = new FormData();
    form.append("intent", "remove_sku");
    form.append("variantId", variantId);
    fetcher.submit(form, { method: "POST" });
  };

  const saved = fetcher.state === "idle" && fetcher.data?.ok;

  return (
    <Page
      title={supplier.name}
      backAction={{ content: "Suppliers", url: "/app/suppliers" }}
    >
      <Layout>
        <Layout.Section>
          {saved && (
            <Banner tone="success" onDismiss={() => {}}>
              Saved successfully.
            </Banner>
          )}

          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Add SKUs by vendor</Text>
              <Text tone="subdued">
                Links all SKUs from a Shopify vendor to this supplier at once.
              </Text>
              <Select
                label="Shopify vendor"
                options={vendorOptions}
                value={selectedVendor}
                onChange={setSelectedVendor}
              />
              <TextField
                label="Default cost per unit"
                type="number"
                value={vendorCost}
                onChange={setVendorCost}
                prefix="$"
                autoComplete="off"
              />
              <Button
                variant="primary"
                onClick={handleAddByVendor}
                disabled={!selectedVendor}
                loading={fetcher.state !== "idle"}
              >
                Add all SKUs from {selectedVendor || "selected vendor"}
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd">Linked SKUs</Text>
                <Badge>{String(supplier.skus.length)}</Badge>
              </InlineStack>
              {supplier.skus.length === 0 ? (
                <EmptyState heading="No SKUs linked yet" image="">
                  <p>Add SKUs by vendor above.</p>
                </EmptyState>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      {["Supplier Code", "Cost", ""].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>
                          <Text variant="headingSm">{h}</Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {supplier.skus.map(s => (
                      <tr key={s.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td style={{ padding: "8px 12px" }}>
                          <Text>{s.supplierCode || "—"}</Text>
                        </td>
                        <td style={{ padding: "8px 12px" }}>
                          <Text>${s.cost.toFixed(2)}</Text>
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}>
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => handleRemove(s.variantId)}
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}