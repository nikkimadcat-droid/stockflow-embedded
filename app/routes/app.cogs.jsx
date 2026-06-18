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
  Badge,
  Tabs,
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

async function fetchCOGSData({ admin, shop, locationId, startDate, endDate }) {
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

    items.push({
      variantId: vid,
      productTitle: data.productTitle,
      sku: data.sku,
      cost,
      qty: data.qty,
      cogs,
      revenue: data.revenue,
      margin,
      avgPrice,
    });
  }

  items.sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));

  const grossMargin = totalRevenue > 0
    ? ((1 - totalCOGS / totalRevenue) * 100).toFixed(1)
    : null;

  return { items, totalCOGS, totalRevenue, grossMargin, skusWithCost, skusNoCost, startDate, endDate };
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "loadPeriodA" || intent === "loadPeriodB") {
    const locationId = form.get("locationId");
    const startDate = form.get("startDate");
    const endDate = form.get("endDate");
    const data = await fetchCOGSData({ admin, shop, locationId, startDate, endDate });
    return { ok: true, intent, ...data };
  }

  return { ok: false };
};

function downloadComparisonCSV(periodA, periodB, labelA, labelB) {
  // Build a combined map of all SKUs from both periods
  const allSkus = new Map();
  for (const item of periodA.items) allSkus.set(item.variantId, { ...item, aQty: item.qty, aRevenue: item.revenue, aMargin: item.margin, aCogs: item.cogs, aAvgPrice: item.avgPrice });
  for (const item of periodB.items) {
    if (allSkus.has(item.variantId)) {
      const existing = allSkus.get(item.variantId);
      allSkus.set(item.variantId, { ...existing, bQty: item.qty, bRevenue: item.revenue, bMargin: item.margin, bCogs: item.cogs, bAvgPrice: item.avgPrice });
    } else {
      allSkus.set(item.variantId, { ...item, aQty: null, aRevenue: null, aMargin: null, aCogs: null, aAvgPrice: null, bQty: item.qty, bRevenue: item.revenue, bMargin: item.margin, bCogs: item.cogs, bAvgPrice: item.avgPrice });
    }
  }

  const rows = [
    [`MadCat COGS Comparison — ${labelA} vs ${labelB}`],
    [],
    ["", `${labelA} COGS`, `${labelA} Revenue`, `${labelA} Margin`, `${labelB} COGS`, `${labelB} Revenue`, `${labelB} Margin`, "Margin Δ", "Revenue Δ"],
    ["TOTAL",
      periodA.totalCOGS.toFixed(2), periodA.totalRevenue.toFixed(2), periodA.grossMargin != null ? `${periodA.grossMargin}%` : "—",
      periodB.totalCOGS.toFixed(2), periodB.totalRevenue.toFixed(2), periodB.grossMargin != null ? `${periodB.grossMargin}%` : "—",
      periodA.grossMargin != null && periodB.grossMargin != null ? `${(parseFloat(periodB.grossMargin) - parseFloat(periodA.grossMargin)).toFixed(1)}%` : "—",
      `${((periodB.totalRevenue - periodA.totalRevenue) / periodA.totalRevenue * 100).toFixed(1)}%`,
    ],
    [],
    ["Product", "SKU",
      `${labelA} Units`, `${labelA} Avg Price`, `${labelA} Margin`,
      `${labelB} Units`, `${labelB} Avg Price`, `${labelB} Margin`,
      "Margin Δ", "Avg Price Δ",
    ],
    ...[...allSkus.values()].map((r) => {
      const marginDelta = r.aMargin != null && r.bMargin != null ? (r.bMargin - r.aMargin).toFixed(1) : "";
      const priceDelta = r.aAvgPrice != null && r.bAvgPrice != null ? (r.bAvgPrice - r.aAvgPrice).toFixed(2) : "";
      return [
        r.productTitle, r.sku || "",
        r.aQty ?? "", r.aAvgPrice != null ? r.aAvgPrice.toFixed(2) : "", r.aMargin != null ? `${r.aMargin.toFixed(1)}%` : "",
        r.bQty ?? "", r.bAvgPrice != null ? r.bAvgPrice.toFixed(2) : "", r.bMargin != null ? `${r.bMargin.toFixed(1)}%` : "",
        marginDelta ? `${marginDelta}%` : "", priceDelta ? `$${priceDelta}` : "",
      ];
    }),
  ];

  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `COGS-comparison.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function getDefaultDates() {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfLastMonth = new Date(firstOfThisMonth - 1);
  const firstOfLastMonth = new Date(lastOfLastMonth.getFullYear(), lastOfLastMonth.getMonth(), 1);
  const twoMonthsAgo = new Date(firstOfLastMonth - 1);
  const firstOfTwoMonthsAgo = new Date(twoMonthsAgo.getFullYear(), twoMonthsAgo.getMonth(), 1);
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    aStart: fmt(firstOfTwoMonthsAgo),
    aEnd: fmt(twoMonthsAgo),
    bStart: fmt(firstOfLastMonth),
    bEnd: fmt(lastOfLastMonth),
  };
}

function SummaryCards({ result, label }) {
  return (
    <InlineGrid columns={4} gap="300">
      <Card>
        <BlockStack gap="100">
          <Text variant="headingSm" tone="subdued">{label} · COGS</Text>
          <Text variant="headingLg">${result.totalCOGS.toFixed(0)}</Text>
          <Text tone="subdued" variant="bodySm">{result.startDate} → {result.endDate}</Text>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="100">
          <Text variant="headingSm" tone="subdued">{label} · Revenue</Text>
          <Text variant="headingLg">${result.totalRevenue.toFixed(0)}</Text>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="100">
          <Text variant="headingSm" tone="subdued">{label} · Gross Margin</Text>
          <Text variant="headingLg">{result.grossMargin != null ? `${result.grossMargin}%` : "—"}</Text>
          <Text tone="subdued" variant="bodySm">on SKUs with cost data</Text>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="100">
          <Text variant="headingSm" tone="subdued">{label} · Coverage</Text>
          <Text variant="headingLg">{result.skusWithCost}</Text>
          <Text tone="subdued" variant="bodySm">SKUs with cost · {result.skusNoCost} missing</Text>
        </BlockStack>
      </Card>
    </InlineGrid>
  );
}

function DeltaBadge({ value, suffix = "", higherIsBetter = true }) {
  if (value == null) return <Text>—</Text>;
  const positive = value > 0;
  const tone = positive === higherIsBetter ? "success" : "critical";
  return (
    <Text tone={tone}>
      {positive ? "▲" : "▼"} {Math.abs(value).toFixed(1)}{suffix}
    </Text>
  );
}

export default function COGS() {
  const { locations } = useLoaderData();
  const fetcherA = useFetcher();
  const fetcherB = useFetcher();

  const defaults = getDefaultDates();
  const [aLocationId, setALocationId] = useState("all");
  const [aStartDate, setAStartDate] = useState(defaults.aStart);
  const [aEndDate, setAEndDate] = useState(defaults.aEnd);

  const [bLocationId, setBLocationId] = useState("all");
  const [bStartDate, setBStartDate] = useState(defaults.bStart);
  const [bEndDate, setBEndDate] = useState(defaults.bEnd);

  const [periodA, setPeriodA] = useState(null);
  const [periodB, setPeriodB] = useState(null);

  const [selectedTab, setSelectedTab] = useState(0);

  const isLoadingA = fetcherA.state !== "idle";
  const isLoadingB = fetcherB.state !== "idle";

  if (fetcherA.state === "idle" && fetcherA.data?.intent === "loadPeriodA" && fetcherA.data !== periodA) {
    setPeriodA(fetcherA.data);
  }
  if (fetcherB.state === "idle" && fetcherB.data?.intent === "loadPeriodB" && fetcherB.data !== periodB) {
    setPeriodB(fetcherB.data);
  }

  function handleLoadA() {
    setPeriodA(null);
    const fd = new FormData();
    fd.append("intent", "loadPeriodA");
    fd.append("locationId", aLocationId === "all" ? "" : aLocationId);
    fd.append("startDate", aStartDate);
    fd.append("endDate", aEndDate);
    fetcherA.submit(fd, { method: "post" });
  }

  function handleLoadB() {
    setPeriodB(null);
    const fd = new FormData();
    fd.append("intent", "loadPeriodB");
    fd.append("locationId", bLocationId === "all" ? "" : bLocationId);
    fd.append("startDate", bStartDate);
    fd.append("endDate", bEndDate);
    fetcherB.submit(fd, { method: "post" });
  }

  const locationOptions = [
    { label: "All locations", value: "all" },
    ...locations.map((l) => ({ label: l.name, value: l.id })),
  ];

  const labelA = `Period A (${aStartDate} → ${aEndDate})`;
  const labelB = `Period B (${bStartDate} → ${bEndDate})`;

  // Build comparison table — all SKUs that appear in either period
  const comparisonRows = (() => {
    if (!periodA && !periodB) return [];
    const map = new Map();
    if (periodA) {
      for (const item of periodA.items) {
        map.set(item.variantId, { ...item, aQty: item.qty, aRevenue: item.revenue, aMargin: item.margin, aCogs: item.cogs, aAvgPrice: item.avgPrice, bQty: null, bRevenue: null, bMargin: null, bCogs: null, bAvgPrice: null });
      }
    }
    if (periodB) {
      for (const item of periodB.items) {
        if (map.has(item.variantId)) {
          const ex = map.get(item.variantId);
          map.set(item.variantId, { ...ex, bQty: item.qty, bRevenue: item.revenue, bMargin: item.margin, bCogs: item.cogs, bAvgPrice: item.avgPrice });
        } else {
          map.set(item.variantId, { ...item, aQty: null, aRevenue: null, aMargin: null, aCogs: null, aAvgPrice: null, bQty: item.qty, bRevenue: item.revenue, bMargin: item.margin, bCogs: item.cogs, bAvgPrice: item.avgPrice });
        }
      }
    }
    return [...map.values()].sort((a, b) => ((b.bRevenue ?? b.aRevenue ?? 0) - (a.bRevenue ?? a.aRevenue ?? 0)));
  })();

  const tabs = [
    { id: "comparison", content: "Side-by-Side Comparison" },
    { id: "periodA", content: `Period A${periodA ? ` (${periodA.startDate})` : ""}` },
    { id: "periodB", content: `Period B${periodB ? ` (${periodB.startDate})` : ""}` },
  ];

  return (
    <Page title="COGS Tracking">
      <Layout>

        {/* Period A controls */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Period A</Text>
              <InlineStack gap="300" blockAlign="end" wrap={false}>
                <Select label="Location" options={locationOptions} value={aLocationId} onChange={setALocationId} />
                <TextField label="Start date" type="date" value={aStartDate} onChange={setAStartDate} />
                <TextField label="End date" type="date" value={aEndDate} onChange={setAEndDate} />
                <Button variant="primary" onClick={handleLoadA} loading={isLoadingA}>
                  {periodA ? "↺ Reload A" : "Load Period A"}
                </Button>
              </InlineStack>
              {isLoadingA && <Text tone="subdued">Loading Period A…</Text>}
              {periodA && !isLoadingA && (
                <Text tone="subdued">
                  Loaded: ${periodA.totalRevenue.toFixed(0)} revenue · {periodA.grossMargin}% margin · {periodA.items.length} SKUs
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Period B controls */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Period B</Text>
              <InlineStack gap="300" blockAlign="end" wrap={false}>
                <Select label="Location" options={locationOptions} value={bLocationId} onChange={setBLocationId} />
                <TextField label="Start date" type="date" value={bStartDate} onChange={setBStartDate} />
                <TextField label="End date" type="date" value={bEndDate} onChange={setBEndDate} />
                <Button variant="primary" onClick={handleLoadB} loading={isLoadingB}>
                  {periodB ? "↺ Reload B" : "Load Period B"}
                </Button>
              </InlineStack>
              {isLoadingB && <Text tone="subdued">Loading Period B…</Text>}
              {periodB && !isLoadingB && (
                <Text tone="subdued">
                  Loaded: ${periodB.totalRevenue.toFixed(0)} revenue · {periodB.grossMargin}% margin · {periodB.items.length} SKUs
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Summary cards — show whichever periods are loaded */}
        {periodA && !isLoadingA && (
          <Layout.Section>
            <SummaryCards result={periodA} label="Period A" />
          </Layout.Section>
        )}
        {periodB && !isLoadingB && (
          <Layout.Section>
            <SummaryCards result={periodB} label="Period B" />
          </Layout.Section>
        )}

        {/* Delta summary — only when both loaded */}
        {periodA && periodB && !isLoadingA && !isLoadingB && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Period A → Period B Change</Text>
                <InlineGrid columns={4} gap="300">
                  <BlockStack gap="100">
                    <Text tone="subdued" variant="bodySm">Revenue Δ</Text>
                    <DeltaBadge value={periodB.totalRevenue - periodA.totalRevenue} suffix="" higherIsBetter={true} />
                    <Text tone="subdued" variant="bodySm">${Math.abs(periodB.totalRevenue - periodA.totalRevenue).toFixed(0)}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued" variant="bodySm">COGS Δ</Text>
                    <DeltaBadge value={periodB.totalCOGS - periodA.totalCOGS} suffix="" higherIsBetter={false} />
                    <Text tone="subdued" variant="bodySm">${Math.abs(periodB.totalCOGS - periodA.totalCOGS).toFixed(0)}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued" variant="bodySm">Gross Margin Δ</Text>
                    <DeltaBadge
                      value={periodA.grossMargin != null && periodB.grossMargin != null ? parseFloat(periodB.grossMargin) - parseFloat(periodA.grossMargin) : null}
                      suffix="%"
                      higherIsBetter={true}
                    />
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued" variant="bodySm">Export</Text>
                    <Button onClick={() => downloadComparisonCSV(periodA, periodB, labelA, labelB)}>
                      ↓ Export comparison CSV
                    </Button>
                  </BlockStack>
                </InlineGrid>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Tabs: comparison table + individual period tables */}
        {(periodA || periodB) && (
          <Layout.Section>
            <Card padding="0">
              <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                <div style={{ padding: "0" }}>

                  {/* Comparison tab */}
                  {selectedTab === 0 && (
                    <div style={{ overflowX: "auto", padding: "12px" }}>
                      {!periodA || !periodB ? (
                        <Text tone="subdued">Load both periods to see the comparison.</Text>
                      ) : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                          <thead>
                            <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                              <th style={{ padding: "8px 10px", textAlign: "left" }}><Text variant="headingSm">Product</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "left" }}><Text variant="headingSm">SKU</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">A Units</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">A Avg $</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">A Margin</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">B Units</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">B Avg $</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">B Margin</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">Margin Δ</Text></th>
                              <th style={{ padding: "8px 10px", textAlign: "center" }}><Text variant="headingSm">Price Δ</Text></th>
                            </tr>
                          </thead>
                          <tbody>
                            {comparisonRows.map((row, i) => {
                              const marginDelta = row.aMargin != null && row.bMargin != null ? row.bMargin - row.aMargin : null;
                              const priceDelta = row.aAvgPrice != null && row.bAvgPrice != null ? row.bAvgPrice - row.aAvgPrice : null;
                              return (
                                <tr key={i} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                  <td style={{ padding: "7px 10px" }}><Text>{row.productTitle}</Text></td>
                                  <td style={{ padding: "7px 10px" }}><Text>{row.sku || "—"}</Text></td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}><Text tone="subdued">{row.aQty ?? "—"}</Text></td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}><Text tone="subdued">{row.aAvgPrice != null ? `$${row.aAvgPrice.toFixed(2)}` : "—"}</Text></td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                                    <Text tone={row.aMargin == null ? undefined : row.aMargin < 20 ? "critical" : row.aMargin < 30 ? "caution" : "success"}>
                                      {row.aMargin != null ? `${row.aMargin.toFixed(1)}%` : "—"}
                                    </Text>
                                  </td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}><Text tone="subdued">{row.bQty ?? "—"}</Text></td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}><Text tone="subdued">{row.bAvgPrice != null ? `$${row.bAvgPrice.toFixed(2)}` : "—"}</Text></td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                                    <Text tone={row.bMargin == null ? undefined : row.bMargin < 20 ? "critical" : row.bMargin < 30 ? "caution" : "success"}>
                                      {row.bMargin != null ? `${row.bMargin.toFixed(1)}%` : "—"}
                                    </Text>
                                  </td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                                    <DeltaBadge value={marginDelta} suffix="%" higherIsBetter={true} />
                                  </td>
                                  <td style={{ padding: "7px 10px", textAlign: "center" }}>
                                    <DeltaBadge value={priceDelta} suffix="" higherIsBetter={true} />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}

                  {/* Period A individual table */}
                  {selectedTab === 1 && (
                    <div style={{ overflowX: "auto", padding: "12px" }}>
                      {!periodA ? <Text tone="subdued">Period A not loaded yet.</Text> : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                          <thead>
                            <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                              {["Product", "SKU", "Cost", "Avg Retail", "Units Sold", "COGS", "Revenue", "Gross Margin"].map((h, i) => (
                                <th key={i} style={{ padding: "8px 10px", textAlign: i >= 2 ? "center" : "left" }}>
                                  <Text variant="headingSm">{h}</Text>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {periodA.items.map((item, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                <td style={{ padding: "7px 10px" }}><Text>{item.productTitle}</Text></td>
                                <td style={{ padding: "7px 10px" }}><Text>{item.sku || "—"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text tone={item.cost == null ? "critical" : undefined}>{item.cost != null ? `$${item.cost.toFixed(2)}` : "no cost"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>{item.avgPrice != null ? `$${item.avgPrice.toFixed(2)}` : "—"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>{item.qty}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>{item.cogs != null ? `$${item.cogs.toFixed(2)}` : "—"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>${item.revenue.toFixed(2)}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}>
                                  <Text tone={item.margin == null ? undefined : item.margin < 20 ? "critical" : item.margin < 30 ? "caution" : "success"}>
                                    {item.margin != null ? `${item.margin.toFixed(1)}%` : "—"}
                                  </Text>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}

                  {/* Period B individual table */}
                  {selectedTab === 2 && (
                    <div style={{ overflowX: "auto", padding: "12px" }}>
                      {!periodB ? <Text tone="subdued">Period B not loaded yet.</Text> : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                          <thead>
                            <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                              {["Product", "SKU", "Cost", "Avg Retail", "Units Sold", "COGS", "Revenue", "Gross Margin"].map((h, i) => (
                                <th key={i} style={{ padding: "8px 10px", textAlign: i >= 2 ? "center" : "left" }}>
                                  <Text variant="headingSm">{h}</Text>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {periodB.items.map((item, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                <td style={{ padding: "7px 10px" }}><Text>{item.productTitle}</Text></td>
                                <td style={{ padding: "7px 10px" }}><Text>{item.sku || "—"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text tone={item.cost == null ? "critical" : undefined}>{item.cost != null ? `$${item.cost.toFixed(2)}` : "no cost"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>{item.avgPrice != null ? `$${item.avgPrice.toFixed(2)}` : "—"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>{item.qty}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>{item.cogs != null ? `$${item.cogs.toFixed(2)}` : "—"}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}><Text>${item.revenue.toFixed(2)}</Text></td>
                                <td style={{ padding: "7px 10px", textAlign: "center" }}>
                                  <Text tone={item.margin == null ? undefined : item.margin < 20 ? "critical" : item.margin < 30 ? "caution" : "success"}>
                                    {item.margin != null ? `${item.margin.toFixed(1)}%` : "—"}
                                  </Text>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}

                </div>
              </Tabs>
            </Card>
          </Layout.Section>
        )}

        {!periodA && !periodB && !isLoadingA && !isLoadingB && (
          <Layout.Section>
            <Card>
              <EmptyState heading="Load one or both periods to get started" image="">
                <p>Set date ranges for Period A and Period B, then load each. Once both are loaded you'll see a side-by-side comparison with margin and price deltas.</p>
              </EmptyState>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}