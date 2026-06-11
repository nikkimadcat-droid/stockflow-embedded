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
  TextField,
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
    const startDate = form.get("startDate"); // YYYY-MM-DD
    const endDate = form.get("endDate");     // YYYY-MM-DD

    const sinceStr = new Date(startDate + "T00:00:00.000Z").toISOString();
    const untilStr = new Date(endDate + "T23:59:59.999Z").toISOString();

    const locationNumericId = locationId ? locationId.split("/").pop() : null;
    const queryStr = locationNumericId
      ? `created_at:>${sinceStr} created_at:<${untilStr} location_id:${locationNumericId}`
      : `created_at:>${sinceStr} created_at:<${untilStr}`;

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

    const variantIds = Object.keys(salesMap);
    const supplierSkus = await db.supplierSku.findMany({
      where: { shop, variantId: { in: variantIds } },
    });
    const costMap = Object.fromEntries(supplierSkus.map((s) => [s.variantId, parseFloat(s.cost ?? 0)]));

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
      const avgPrice = data.qty > 0 ? data.revenue / data.qty : null;

      if (cogs != null) { totalCOGS += cogs; skusWithCost++; }
      else { skusNoCost++; }
      totalRevenue += data.revenue;

      items.push({ productTitle: data.productTitle, sku: data.sku, cost, qty: data.qty, cogs, revenue: data.revenue, margin, avgPrice });
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
      startDate,
      endDate,
    };
  }

  return { ok: false };
};

function downloadCSV(result, locationLabel) {
  const periodLabel = `${result.startDate} to ${result.endDate}`;
  const rows = [
    [`MadCat COGS Report — ${periodLabel}${locationLabel ? ` — ${locationLabel}` : ""}`],
    [],
    ["", "COGS", "Revenue", "Gross Margin"],
    ["TOTAL", result.totalCOGS.toFixed(2), result.totalRevenue.toFixed(2), result.grossMargin != null ? `${result.grossMargin}%` : "—"],
    [],
    ["Product", "SKU", "Unit Cost", "Units Sold", "COGS", "Revenue", "Avg Retail", "Gross Margin"],
    ...result.items.map((i) => [
      i.productTitle,
      i.sku || "",
      i.cost != null ? i.cost.toFixed(2) : "",
      i.qty,
      i.cogs != null ? i.cogs.toFixed(2) : "",
      i.revenue.toFixed(2),
      i.avgPrice != null ? i.avgPrice.toFixed(2) : "",
      i.margin != null ? `${i.margin.toFixed(1)}%` : "",
    ]),
  ];

  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `COGS-${result.startDate}-${result.endDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Default to previous calendar month
function getDefaultDates() {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfLastMonth = new Date(firstOfThisMonth - 1);
  const firstOfLastMonth = new Date(lastOfLastMonth.getFullYear(), lastOfLastMonth.getMonth(), 1);
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { start: fmt(firstOfLastMonth), end: fmt(lastOfLastMonth) };
}

export default function COGS() {
  const { locations } = useLoaderData();
  const fetcher = useFetcher();

  const defaults = getDefaultDates();
  const [locationId, setLocationId] = useState("all");
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
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
    fd.append("startDate", startDate);
    fd.append("endDate", endDate);
    fetcher.submit(fd, { method: "post" });
  }

  const locationOptions = [
    { label: "All locations", value: "all" },
    ...locations.map((l) => ({ label: l.name, value: l.id })),
  ];

  const locationLabel = locationId === "all"
    ? "All locations"
    : locations.find((l) => l.id === locationId)?.name ?? "";

  return (
    <Page title="COGS Tracking">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" blockAlign="end" wrap={false}>
                <Select
                  label="Location"
                  options={locationOptions}
                  value={locationId}
                  onChange={setLocationId}
                />
                <TextField
                  label="Start date"
                  type="date"
                  value={startDate}
                  onChange={setStartDate}
                />
                <TextField
                  label="End date"
                  type="date"
                  value={endDate}
                  onChange={setEndDate}
                />
                <Button variant="primary" onClick={handleLoad} loading={isLoading}>
                  {result ? "↺ Reload" : "Load COGS"}
                </Button>
                {result && (
                  <Button onClick={() => downloadCSV(result, locationLabel)}>
                    ↓ Export CSV
                  </Button>
                )}
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
                    <Text variant="headingMd">COGS</Text>
                    <Text variant="heading2xl">${result.totalCOGS.toFixed(0)}</Text>
                    <Text tone="subdued">{result.startDate} → {result.endDate}</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingMd">Revenue</Text>
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
                        {["Product", "SKU", "Cost", "Avg Retail", "Units Sold", "COGS", "Revenue", "Gross Margin"].map((h, i) => (
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
                            <Text>{item.avgPrice != null ? `$${item.avgPrice.toFixed(2)}` : "—"}</Text>
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
              <EmptyState heading="Select a date range and load COGS" image="">
                <p>Choose a location and date range, then click Load COGS. Defaults to last calendar month.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}