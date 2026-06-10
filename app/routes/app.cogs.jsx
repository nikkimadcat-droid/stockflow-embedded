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
  InlineGrid,
  Button,
  Text,
  Select,
  Spinner,
  EmptyState,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const locRes = await admin.graphql(`
    query { locations(first: 10) { edges { node { id name } } } }
  `);
  const locJson = await locRes.json();
  const locations = locJson.data.locations.edges.map((e) => e.node);
  return { locations, shop: session.shop };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "loadCOGS") {
    const locationId = form.get("locationId");
    const days = parseInt(form.get("days") || "30");
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString();

    const locationNumericId = locationId ? locationId.split("/").pop() : null;
    const queryStr = locationNumericId
      ? `created_at:>${sinceStr} location_id:${locationNumericId}`
      : `created_at:>${sinceStr}`;

    let cursor = null;
    let hasMore = true;
    const salesMap = {};

    while (hasMore) {
      const res = await admin.graphql(`
        query($cursor: String, $query: String!) {
          orders(first: 50, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                lineItems(first: 50) {
                  edges {
                    node {
                      quantity
                      originalUnitPriceSet { shopMoney { amount } }
                      variant { id sku product { title } }
                    }
                  }
                }
              }
            }
          }
        }
      `, { variables: { cursor, query: queryStr } });

      const json = await res.json();
      const orders = json.data?.orders;
      hasMore = orders?.pageInfo?.hasNextPage ?? false;
      cursor = orders?.pageInfo?.endCursor ?? null;

      for (const o of orders?.edges ?? []) {
        for (const li of o.node.lineItems.edges) {
          const n = li.node;
          const vid = n.variant?.id;
          if (!vid) continue;
          const price = parseFloat(n.originalUnitPriceSet?.shopMoney?.amount ?? 0);
          if (!salesMap[vid]) {
            salesMap[vid] = {
              variantId: vid,
              sku: n.variant?.sku ?? "",
              productTitle: n.variant?.product?.title ?? "—",
              qty: 0,
              revenue: 0,
            };
          }
          salesMap[vid].qty += n.quantity;
          salesMap[vid].revenue += price * n.quantity;
        }
      }
    }

    // Pull supplier costs from DB
    const variantIds = Object.keys(salesMap);
    const supplierSkus = await db.supplierSku.findMany({
      where: { shop, variantId: { in: variantIds } },
    });
    const costMap = Object.fromEntries(supplierSkus.map((s) => [s.variantId, parseFloat(s.cost ?? 0)]));

    // Fall back to Shopify unitCost for variants missing from DB
    const missingIds = variantIds.filter((id) => costMap[id] == null);
    if (missingIds.length > 0) {
      for (let i = 0; i < missingIds.length; i += 50) {
        const batch = missingIds.slice(i, i + 50);
        const idsQuery = batch.map((id) => `id:${id.split("/").pop()}`).join(" OR ");
        const res = await admin.graphql(`
          query($query: String!) {
            productVariants(first: 50, query: $query) {
              edges {
                node {
                  id
                  inventoryItem { unitCost { amount } }
                }
              }
            }
          }
        `, { variables: { query: idsQuery } });
        const json = await res.json();
        for (const e of json.data?.productVariants?.edges ?? []) {
          const vid = e.node.id;
          const cost = e.node.inventoryItem?.unitCost?.amount;
          if (cost != null) costMap[vid] = parseFloat(cost);
        }
      }
    }

    // Build rows
    let totalCOGS = 0;
    let totalRevenue = 0;
    let skusWithCost = 0;
    let skusNoCost = 0;

    const items = [];
    for (const [vid, data] of Object.entries(salesMap)) {
      const cost = costMap[vid] ?? null;
      const cogs = cost != null ? cost * data.qty : null;
      const margin = cost != null && data.revenue > 0
        ? ((1 - (cost * data.qty) / data.revenue) * 100)
        : null;

      if (cogs != null) {
        totalCOGS += cogs;
        skusWithCost++;
      } else {
        skusNoCost++;
      }
      totalRevenue += data.revenue;

      items.push({
        productTitle: data.productTitle,
        sku: data.sku,
        cost,
        qty: data.qty,
        cogs,
        revenue: data.revenue,
        margin,
      });
    }

    items.sort((a, b) => (b.cogs ?? -1) - (a.cogs ?? -1));

    const grossMargin = totalRevenue > 0
      ? ((1 - totalCOGS / totalRevenue) * 100).toFixed(1)
      : null;

    return {
      ok: true,
      intent: "loadCOGS",
      items,
      totalCOGS,
      totalRevenue,
      grossMargin,
      skusWithCost,
      skusNoCost,
    };
  }

  return { ok: false };
};

export default function COGS() {
  const { locations } = useLoaderData();
  const fetcher = useFetcher();

  const [locationId, setLocationId] = useState("all");
  const [days, setDays] = useState("30");
  const [result, setResult] = useState(null);

  const isLoading = fetcher.state !== "idle";
  const fetcherData = fetcher.data;

  if (fetcher.state === "idle" && fetcherData?.intent === "loadCOGS" && fetcherData !== result) {
    setResult(fetcherData);
  }

  function handleLoad() {
    setResult(null);
    const fd = new FormData();
    fd.append("intent", "loadCOGS");
    fd.append("locationId", locationId === "all" ? "" : locationId);
    fd.append("days", days);
    fetcher.submit(fd, { method: "post" });
  }

  const locationOptions = [
    { label: "All locations", value: "all" },
    ...locations.map((l) => ({ label: l.name, value: l.id })),
  ];

  const daysOptions = [
    { label: "Last 30 days", value: "30" },
    { label: "Last 60 days", value: "60" },
    { label: "Last 90 days", value: "90" },
  ];

  return (
    <Page title="COGS Tracking">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" blockAlign="end">
                <Select
                  label="Location"
                  options={locationOptions}
                  value={locationId}
                  onChange={setLocationId}
                />
                <Select
                  label="Period"
                  options={daysOptions}
                  value={days}
                  onChange={setDays}
                />
                <Button variant="primary" onClick={handleLoad} loading={isLoading}>
                  {result ? "↺ Reload" : "Load COGS"}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {isLoading && (
          <Layout.Section>
            <div style={{ textAlign: "center", padding: "3rem" }}>
              <Spinner size="large" />
              <Text>Crunching orders — may take a moment for large date ranges…</Text>
            </div>
          </Layout.Section>
        )}

        {!isLoading && result && (
          <>
            <Layout.Section>
              <InlineGrid columns={4} gap="400">
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingMd">COGS ({days}d)</Text>
                    <Text variant="heading2xl">${result.totalCOGS.toFixed(0)}</Text>
                    <Text tone="subdued">supplier cost × units sold</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingMd">Revenue ({days}d)</Text>
                    <Text variant="heading2xl">${result.totalRevenue.toFixed(0)}</Text>
                    <Text tone="subdued">from orders</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingMd">Gross Margin</Text>
                    <Text variant="heading2xl">
                      {result.grossMargin != null ? `${result.grossMargin}%` : "—"}
                    </Text>
                    <Text tone="subdued">on SKUs with cost data</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingMd">Coverage</Text>
                    <Text variant="heading2xl">{result.skusWithCost}</Text>
                    <Text tone="subdued">
                      SKUs with cost · {result.skusNoCost} missing
                    </Text>
                  </BlockStack>
                </Card>
              </InlineGrid>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                        {["Product", "SKU", "Cost", "Units Sold", "COGS", "Revenue", "Gross Margin"].map((h, i) => (
                          <th key={i} style={{ padding: "8px 12px", textAlign: i >= 2 ? "center" : "left" }}>
                            <Text variant="headingSm">{h}</Text>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.items.map((item, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid #f1f2f3" }}>
                          <td style={{ padding: "8px 12px" }}><Text>{item.productTitle}</Text></td>
                          <td style={{ padding: "8px 12px" }}><Text>{item.sku || "—"}</Text></td>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <Text tone={item.cost == null ? "critical" : undefined}>
                              {item.cost != null ? `$${item.cost.toFixed(2)}` : "no cost"}
                            </Text>
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <Text>{item.qty}</Text>
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <Text>{item.cogs != null ? `$${item.cogs.toFixed(2)}` : "—"}</Text>
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <Text>${item.revenue.toFixed(2)}</Text>
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <Text
                              tone={
                                item.margin == null ? undefined
                                : item.margin < 20 ? "critical"
                                : item.margin < 30 ? "caution"
                                : "success"
                              }
                            >
                              {item.margin != null ? `${item.margin.toFixed(1)}%` : "—"}
                            </Text>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </Layout.Section>
          </>
        )}

        {!isLoading && !result && (
          <Layout.Section>
            <Card>
              <EmptyState heading="Select filters and load COGS" image="">
                <p>Choose a location and time period, then click Load COGS to calculate gross margin from your supplier and Shopify costs.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}