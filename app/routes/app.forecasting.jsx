import { useState, useMemo } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Button,
  Select,
  Text,
  Badge,
  Spinner,
  Banner,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const locRes = await admin.graphql(`
    query {
      locations(first: 10) {
        edges { node { id name } }
      }
    }
  `);
  const locJson = await locRes.json();
  const locations = locJson.data.locations.edges.map(e => e.node);

  const vendors = new Set();
  const types = new Set();
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const res = await admin.graphql(`
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { vendor productType } }
        }
      }
    `, { variables: { cursor } });
    const json = await res.json();
    const page = json.data.products;
    for (const { node: p } of page.edges) {
      if (p.vendor) vendors.add(p.vendor);
      if (p.productType) types.add(p.productType);
    }
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return {
    locations,
    vendors: [...vendors].sort(),
    types: [...types].sort(),
  };
};

async function fetchOrderSales(admin, sinceStr, untilStr, variantIds) {
  const salesMap = {};
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const res = await admin.graphql(`
      query($cursor: String, $query: String!) {
        orders(first: 250, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              lineItems(first: 50) {
                edges {
                  node {
                    variant { id }
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    `, { variables: { cursor, query: `created_at:>="${sinceStr}" created_at:<="${untilStr}"` } });

    const json = await res.json();
    const data = json.data?.orders;
    hasMore = data?.pageInfo?.hasNextPage ?? false;
    cursor = data?.pageInfo?.endCursor ?? null;

    for (const o of data?.edges ?? []) {
      for (const li of o.node.lineItems.edges) {
        const vid = li.node.variant?.id;
        if (vid && variantIds.has(vid)) {
          salesMap[vid] = (salesMap[vid] ?? 0) + li.node.quantity;
        }
      }
    }
  }
  return salesMap;
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "fetchForecast") {
    const locationId = form.get("locationId");
    const vendorFilter = form.get("vendorFilter");
    const typeFilter = form.get("typeFilter");
    const days = Number(form.get("days")) || 30;
    const lowStockDays = Number(form.get("lowStockDays")) || 14;

    const now = new Date();
    const periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() - days);
    const prevStart = new Date(periodStart);
    prevStart.setDate(prevStart.getDate() - days);

    const fmt = (d) => d.toISOString().split("T")[0];
    const currentSince = fmt(periodStart);
    const currentUntil = fmt(now);
    const prevSince = fmt(prevStart);
    const prevUntil = fmt(periodStart);

    // fetch filtered products
    const products = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const query = vendorFilter
        ? `vendor:'${vendorFilter}'`
        : typeFilter
        ? `product_type:'${typeFilter}'`
        : "";

      const prodRes = await admin.graphql(`
        query($cursor: String, $query: String!) {
          products(first: 250, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                title
                vendor
                productType
                variants(first: 100) {
                  edges {
                    node {
                      id
                      sku
                      inventoryItem { id }
                    }
                  }
                }
              }
            }
          }
        }
      `, { variables: { cursor, query } });

      const prodJson = await prodRes.json();
      const page = prodJson.data.products;
      products.push(...page.edges.map(e => e.node));
      hasMore = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }

    const filtered = products.filter(p =>
      (!vendorFilter || p.vendor === vendorFilter) &&
      (!typeFilter || p.productType === typeFilter)
    );

    const variantMap = {};
    for (const p of filtered) {
      for (const { node: v } of p.variants.edges) {
        variantMap[v.id] = {
          variantId: v.id,
          productTitle: p.title,
          vendor: p.vendor,
          productType: p.productType,
          sku: v.sku || "—",
          currentSales: 0,
          prevSales: 0,
          onHand: 0,
        };
      }
    }

    const variantIds = new Set(Object.keys(variantMap));

    // fetch current and previous period orders in parallel
    const [currentSalesMap, prevSalesMap] = await Promise.all([
      fetchOrderSales(admin, currentSince, currentUntil, variantIds),
      fetchOrderSales(admin, prevSince, prevUntil, variantIds),
    ]);

    for (const [vid, qty] of Object.entries(currentSalesMap)) {
      if (variantMap[vid]) variantMap[vid].currentSales = qty;
    }
    for (const [vid, qty] of Object.entries(prevSalesMap)) {
      if (variantMap[vid]) variantMap[vid].prevSales = qty;
    }

    // fetch inventory levels
    let invCursor = null;
    let invHasMore = true;
    while (invHasMore) {
      const invRes = await admin.graphql(`
        query($locationId: ID!, $cursor: String) {
          location(id: $locationId) {
            inventoryLevels(first: 250, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  quantities(names: ["available"]) { quantity }
                  item { variant { id } }
                }
              }
            }
          }
        }
      `, { variables: { locationId, cursor: invCursor } });

      const invJson = await invRes.json();
      const levels = invJson.data?.location?.inventoryLevels;
      invHasMore = levels?.pageInfo?.hasNextPage ?? false;
      invCursor = levels?.pageInfo?.endCursor ?? null;

      for (const e of levels?.edges ?? []) {
        const vid = e.node.item?.variant?.id;
        if (vid && variantIds.has(vid)) {
          variantMap[vid].onHand = e.node.quantities?.[0]?.quantity ?? 0;
        }
      }
    }

    // build rows with flags
    const rows = Object.values(variantMap)
      .filter(r => r.currentSales > 0 || r.prevSales > 0 || r.onHand > 0)
      .map(r => {
        const dailyVelocity = r.currentSales / days;
        const daysOfStock = dailyVelocity > 0 ? Math.floor(r.onHand / dailyVelocity) : null;

        let trend = "stable";
        let changePercent = 0;
        if (r.prevSales > 0) {
          changePercent = Math.round(((r.currentSales - r.prevSales) / r.prevSales) * 100);
          if (changePercent <= -20) trend = "slowing";
          else if (changePercent >= 20) trend = "spiking";
        } else if (r.currentSales > 0) {
          trend = "new";
        }

        const isLowStock = daysOfStock !== null && daysOfStock <= lowStockDays;

        return {
          ...r,
          dailyVelocity: Math.round(dailyVelocity * 10) / 10,
          daysOfStock,
          trend,
          changePercent,
          isLowStock,
        };
      })
      .sort((a, b) => a.productTitle.localeCompare(b.productTitle));

    return { ok: true, rows, days, lowStockDays };
  }

  return { ok: false };
};

export default function Forecasting() {
  const { locations, vendors, types } = useLoaderData();
  const fetcher = useFetcher();

  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [vendorFilter, setVendorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [days, setDays] = useState("30");
  const [lowStockDays, setLowStockDays] = useState("14");
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadedDays, setLoadedDays] = useState(30);
  const [sortField, setSortField] = useState("productTitle");
  const [sortDir, setSortDir] = useState("asc");

  const isSubmitting = fetcher.state !== "idle";

  if (fetcher.data?.rows && fetcher.data.rows !== rows) {
    setRows(fetcher.data.rows);
    setLoaded(true);
    setLoadedDays(fetcher.data.days);
  }

  function handleLoad() {
    setLoaded(false);
    setRows([]);
    const fd = new FormData();
    fd.append("intent", "fetchForecast");
    fd.append("locationId", locationId);
    fd.append("vendorFilter", vendorFilter);
    fd.append("typeFilter", typeFilter);
    fd.append("days", days);
    fd.append("lowStockDays", lowStockDays);
    fetcher.submit(fd, { method: "post" });
  }

  function handleSort(field) {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function downloadCSV() {
    const headers = ["Product", "Vendor", "SKU", "This Period", "Prev Period", "Trend", "Change %", "On Hand", "Days Left"];
    const csvRows = [
      headers,
      ...sortedRows.map(r => [
        r.productTitle,
        r.vendor,
        r.sku,
        r.currentSales,
        r.prevSales,
        r.trend,
        r.changePercent + "%",
        r.onHand,
        r.daysOfStock ?? "—",
      ]),
    ];
    const csv = csvRows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `forecast-${days}day-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sortedRows = useMemo(() => {
    if (!rows.length) return [];
    return [...rows].sort((a, b) => {
      let av = a[sortField];
      let bv = b[sortField];
      if (av === null) av = -1;
      if (bv === null) bv = -1;
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [rows, sortField, sortDir]);

  function SortHeader({ field, label, align = "left" }) {
    const active = sortField === field;
    const arrow = active ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕";
    return (
      <th
        style={{ padding: "8px 12px", textAlign: align, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
        onClick={() => handleSort(field)}
      >
        <Text variant="headingSm">{label}{arrow}</Text>
      </th>
    );
  }

  function trendBadge(row) {
    if (row.trend === "slowing") return <Badge tone="critical">📉 Slowing {row.changePercent}%</Badge>;
    if (row.trend === "spiking") return <Badge tone="warning">📈 Spiking +{row.changePercent}%</Badge>;
    if (row.trend === "new") return <Badge tone="info">🆕 New seller</Badge>;
    return <Badge tone="success">⚪ Stable</Badge>;
  }

  function daysOfStockBadge(row) {
    if (row.daysOfStock === null) return <Text tone="subdued">—</Text>;
    if (row.isLowStock) return <Badge tone="critical">🔴 {row.daysOfStock}d</Badge>;
    if (row.daysOfStock <= Number(lowStockDays) * 2) return <Badge tone="warning">{row.daysOfStock}d</Badge>;
    return <Text>{row.daysOfStock}d</Text>;
  }

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const vendorOptions = [{ label: "All vendors", value: "" }, ...vendors.map(v => ({ label: v, value: v }))];
  const typeOptions = [{ label: "All product types", value: "" }, ...types.map(t => ({ label: t, value: t }))];
  const daysOptions = [
    { label: "30 days", value: "30" },
    { label: "60 days", value: "60" },
    { label: "90 days", value: "90" },
  ];
  const lowStockOptions = [
    { label: "7 days", value: "7" },
    { label: "14 days", value: "14" },
    { label: "21 days", value: "21" },
    { label: "30 days", value: "30" },
  ];

  const slowingCount = rows.filter(r => r.trend === "slowing").length;
  const spikingCount = rows.filter(r => r.trend === "spiking").length;
  const lowStockCount = rows.filter(r => r.isLowStock).length;

  return (
    <Page title="Forecasting">
      <Layout>
        <Layout.Section>

          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400" wrap>
                <div style={{ minWidth: "180px" }}>
                  <Select label="Location" options={locationOptions} value={locationId} onChange={setLocationId} />
                </div>
                <div style={{ minWidth: "180px" }}>
                  <Select
                    label="Vendor"
                    options={vendorOptions}
                    value={vendorFilter}
                    onChange={val => { setVendorFilter(val); if (val) setTypeFilter(""); }}
                  />
                </div>
                <div style={{ minWidth: "180px" }}>
                  <Select
                    label="Product Type"
                    options={typeOptions}
                    value={typeFilter}
                    onChange={val => { setTypeFilter(val); if (val) setVendorFilter(""); }}
                  />
                </div>
                <div style={{ minWidth: "140px" }}>
                  <Select label="Period" options={daysOptions} value={days} onChange={setDays} />
                </div>
                <div style={{ minWidth: "160px" }}>
                  <Select label="Flag low stock under" options={lowStockOptions} value={lowStockDays} onChange={setLowStockDays} />
                </div>
                <div style={{ paddingTop: "24px" }}>
                  <Button variant="primary" onClick={handleLoad} loading={isSubmitting}>
                    Run forecast
                  </Button>
                </div>
              </InlineStack>
              {days === "90" && (
                <Banner tone="warning">
                  90-day comparisons look back 180 days total. Previous period data may be incomplete on the Shopify Grow plan — results will still show current period sales and days of stock accurately.
                </Banner>
              )}
            </BlockStack>
          </Card>

          {isSubmitting && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <div style={{ marginTop: "1rem" }}>
                <Text>Pulling sales data — this may take a moment…</Text>
              </div>
            </div>
          )}

          {loaded && !isSubmitting && (
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="400" blockAlign="center">
                  <Text variant="headingSm">{rows.length} SKUs · {loadedDays}-day comparison</Text>
                  {lowStockCount > 0 && <Badge tone="critical">🔴 {lowStockCount} low stock</Badge>}
                  {slowingCount > 0 && <Badge tone="critical">📉 {slowingCount} slowing</Badge>}
                  {spikingCount > 0 && <Badge tone="warning">📈 {spikingCount} spiking</Badge>}
                </InlineStack>
                <Button onClick={downloadCSV}>↓ Export CSV</Button>
              </InlineStack>
            </Card>
          )}

          {loaded && !isSubmitting && sortedRows.length > 0 && (
            <Card>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                      <SortHeader field="productTitle" label="Product" />
                      <SortHeader field="sku" label="SKU" />
                      <SortHeader field="currentSales" label="This period" align="right" />
                      <SortHeader field="prevSales" label="Prev period" align="right" />
                      <SortHeader field="changePercent" label="Trend" align="center" />
                      <SortHeader field="onHand" label="On Hand" align="right" />
                      <SortHeader field="daysOfStock" label="Days left" align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => (
                      <tr
                        key={row.variantId}
                        style={{
                          borderBottom: "1px solid #f1f2f3",
                          background:
                            row.isLowStock && row.trend === "slowing" ? "#fff0f0" :
                            row.isLowStock ? "#fff4f4" :
                            row.trend === "slowing" ? "#fffbf0" :
                            row.trend === "spiking" ? "#f4fff6" :
                            "transparent",
                        }}
                      >
                        <td style={{ padding: "8px 12px" }}>
                          <Text>{row.productTitle}</Text>
                          <Text tone="subdued" variant="bodySm">{row.vendor}</Text>
                        </td>
                        <td style={{ padding: "8px 12px" }}><Text>{row.sku}</Text></td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}><Text>{row.currentSales}</Text></td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}><Text tone="subdued">{row.prevSales}</Text></td>
                        <td style={{ padding: "8px 12px", textAlign: "center" }}>{trendBadge(row)}</td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}><Text>{row.onHand}</Text></td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}>{daysOfStockBadge(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {loaded && !isSubmitting && sortedRows.length === 0 && (
            <Card>
              <Text tone="subdued">No sales data found for this filter and period.</Text>
            </Card>
          )}

        </Layout.Section>
      </Layout>
    </Page>
  );
}