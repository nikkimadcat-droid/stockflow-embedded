import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Button,
  Text,
  Badge,
  Divider,
  Spinner,
  EmptyState,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "loadVendors") {
    const vendorMap = {};
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const res = await admin.graphql(`
        query($cursor: String) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                vendor
                variants(first: 100) {
                  edges { node { id } }
                }
              }
            }
          }
        }
      `, { variables: { cursor } });

      const json = await res.json();
      const products = json.data?.products;
      hasMore = products?.pageInfo?.hasNextPage ?? false;
      cursor = products?.pageInfo?.endCursor ?? null;

      for (const e of products?.edges ?? []) {
        const vendor = e.node.vendor;
        if (!vendor) continue;
        if (!vendorMap[vendor]) vendorMap[vendor] = { name: vendor, skus: 0 };
        vendorMap[vendor].skus += e.node.variants.edges.length;
      }
    }

    const vendors = Object.values(vendorMap).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, intent: "loadVendors", vendors };
  }

  if (intent === "loadVendorProducts") {
    const vendor = form.get("vendor");
    const products = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const res = await admin.graphql(`
        query($cursor: String, $query: String!) {
          products(first: 250, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                title
                variants(first: 100) {
                  edges {
                    node {
                      id
                      title
                      sku
                      inventoryItem {
                        unitCost { amount }
                        inventoryLevels(first: 10) {
                          edges {
                            node {
                              quantities(names: ["available"]) { quantity }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `, { variables: { cursor, query: `vendor:"${vendor}"` } });

      const json = await res.json();
      const page = json.data?.products;
      hasMore = page?.pageInfo?.hasNextPage ?? false;
      cursor = page?.pageInfo?.endCursor ?? null;
      for (const e of page?.edges ?? []) products.push(e.node);
    }

    const variantIds = products.flatMap((p) => p.variants.edges.map((v) => v.node.id));
    const supplierSkus = await db.supplierSku.findMany({
      where: { shop, variantId: { in: variantIds } },
    });
    const costMap = Object.fromEntries(supplierSkus.map((s) => [s.variantId, s.cost]));

    const rows = [];
    for (const p of products) {
      for (const ve of p.variants.edges) {
        const v = ve.node;
        const shopifyCost = v.inventoryItem?.unitCost?.amount
          ? parseFloat(v.inventoryItem.unitCost.amount)
          : null;
        const supplierCost = costMap[v.id] ?? null;
        const onHand = (v.inventoryItem?.inventoryLevels?.edges ?? []).reduce(
          (sum, l) => sum + (l.node.quantities?.[0]?.quantity ?? 0), 0
        );
        rows.push({
          productTitle: p.title,
          variantTitle: v.title,
          sku: v.sku ?? "",
          onHand,
          shopifyCost,
          supplierCost,
        });
      }
    }

    rows.sort((a, b) => a.productTitle.localeCompare(b.productTitle));
    return { ok: true, intent: "loadVendorProducts", vendor, rows };
  }

  return { ok: false };
};

export default function Vendors() {
  useLoaderData();
  const fetcher = useFetcher();

  const [vendors, setVendors] = useState(null);
  const [expandedVendor, setExpandedVendor] = useState(null);
  const [vendorProducts, setVendorProducts] = useState({});
  const [loadingVendor, setLoadingVendor] = useState(null);

  const isLoadingVendors = fetcher.state !== "idle" && !loadingVendor;
  const fetcherData = fetcher.data;

  if (fetcher.state === "idle" && fetcherData?.intent === "loadVendors" && fetcherData?.vendors && vendors === null) {
    setVendors(fetcherData.vendors);
  }
  if (fetcher.state === "idle" && fetcherData?.intent === "loadVendorProducts" && fetcherData?.rows && loadingVendor) {
    setVendorProducts((prev) => ({ ...prev, [fetcherData.vendor]: fetcherData.rows }));
    setLoadingVendor(null);
  }

  function handleLoadVendors() {
    const fd = new FormData();
    fd.append("intent", "loadVendors");
    fetcher.submit(fd, { method: "post" });
  }

  function handleToggleVendor(vendorName) {
    if (expandedVendor === vendorName) {
      setExpandedVendor(null);
      return;
    }
    setExpandedVendor(vendorName);
    if (!vendorProducts[vendorName]) {
      setLoadingVendor(vendorName);
      const fd = new FormData();
      fd.append("intent", "loadVendorProducts");
      fd.append("vendor", vendorName);
      fetcher.submit(fd, { method: "post" });
    }
  }

  return (
    <Page title="Vendors">
      <Layout>
        <Layout.Section>

          {vendors === null && (
            <Card>
              <BlockStack gap="400">
                {isLoadingVendors ? (
                  <div style={{ textAlign: "center", padding: "2rem" }}>
                    <Spinner size="large" />
                    <Text>Loading full catalog — this may take a moment…</Text>
                  </div>
                ) : (
                  <EmptyState
                    heading="Load vendor summary"
                    action={{ content: "Load vendors", onAction: handleLoadVendors }}
                    image=""
                  >
                    <p>Fetches all products across your full catalog and groups them by vendor.</p>
                  </EmptyState>
                )}
              </BlockStack>
            </Card>
          )}

          {vendors !== null && (
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd">{vendors.length} vendors</Text>
                <Button variant="plain" onClick={() => { setVendors(null); handleLoadVendors(); }}>
                  ↺ Refresh
                </Button>
              </InlineStack>

              {vendors.map((v) => {
                const isExpanded = expandedVendor === v.name;
                const isLoadingThis = loadingVendor === v.name;
                const products = vendorProducts[v.name];

                return (
                  <Card key={v.name}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text variant="headingMd">{v.name}</Text>
                          <Badge tone="info">{v.skus} SKUs</Badge>
                        </BlockStack>
                        <Button variant="plain" onClick={() => handleToggleVendor(v.name)}>
                          {isExpanded ? "Hide products" : "View products"}
                        </Button>
                      </InlineStack>

                      {isExpanded && (
                        <>
                          <Divider />
                          {isLoadingThis ? (
                            <div style={{ textAlign: "center", padding: "1rem" }}>
                              <Spinner size="small" />
                              <Text tone="subdued">Loading products…</Text>
                            </div>
                          ) : products?.length === 0 ? (
                            <Text tone="subdued">No products found for this vendor.</Text>
                          ) : (
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead>
                                  <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                                    {["Product", "Variant", "SKU", "On Hand (all locations)", "Shopify Cost", "Supplier Cost"].map((h, i) => (
                                      <th key={i} style={{ padding: "8px 12px", textAlign: i >= 3 ? "center" : "left" }}>
                                        <Text variant="headingSm">{h}</Text>
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {products?.map((row, i) => (
                                    <tr key={i} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                      <td style={{ padding: "8px 12px" }}><Text>{row.productTitle}</Text></td>
                                      <td style={{ padding: "8px 12px" }}><Text>{row.variantTitle}</Text></td>
                                      <td style={{ padding: "8px 12px" }}><Text>{row.sku}</Text></td>
                                      <td style={{ padding: "8px 12px", textAlign: "center" }}>
                                        <Text tone={row.onHand <= 0 ? "critical" : row.onHand < 3 ? "caution" : undefined}>
                                          {row.onHand}
                                        </Text>
                                      </td>
                                      <td style={{ padding: "8px 12px", textAlign: "center" }}>
                                        <Text>{row.shopifyCost != null ? `$${row.shopifyCost.toFixed(2)}` : "—"}</Text>
                                      </td>
                                      <td style={{ padding: "8px 12px", textAlign: "center" }}>
                                        <Text>{row.supplierCost != null ? `$${Number(row.supplierCost).toFixed(2)}` : "—"}</Text>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </>
                      )}
                    </BlockStack>
                  </Card>
                );
              })}
            </BlockStack>
          )}

        </Layout.Section>
      </Layout>
    </Page>
  );
}