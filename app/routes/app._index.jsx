import { useState, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page, Layout, Card, Text, BlockStack, InlineGrid,
  InlineStack, Select, Button, Spinner, Badge, Banner,
  DataTable, TextField, Divider, Box,
} from "@shopify/polaris";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GraphQL helper: retries when Shopify throttles, surfaces real errors
async function gql(admin, query, variables = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await admin.graphql(query, { variables });
      const json = await res.json();
      const errs = Array.isArray(json.errors) ? json.errors : [];
      const throttled = errs.some(e => e?.extensions?.code === "THROTTLED");
      if (throttled) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!json.data && json.errors) {
        throw new Error(JSON.stringify(json.errors).slice(0, 300));
      }
      return json;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("Shopify request failed after retries");
}

// Escape apostrophes for Shopify search syntax (e.g. Stella & Chewy's)
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const locRes = await admin.graphql(`
    query { locations(first: 10) { edges { node { id name } } } }
  `);
  const locData = await locRes.json();
  const locations = locData.data.locations.edges.map(e => e.node);

  const prodRes = await admin.graphql(`
    query { productsCount { count } }
  `);
  const prodData = await prodRes.json();
  const productCount = prodData.data.productsCount.count;

  const openPOs = await db.purchaseOrder.count({ where: { status: "draft" } });

  let lastSnapshot = null;
  try {
    lastSnapshot = await db.snapshotCache.findFirst({
      orderBy: { createdAt: "desc" },
      select: { cacheKey: true, lowCount: true, avgST: true, totalUnits: true, createdAt: true },
    });
  } catch (e) {}

  return { locations, productCount, openPOs, lastSnapshot };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "loadDashboard") return { error: "unknown intent" };

  const locationGid = form.get("locationId");
  const productType = form.get("productType") || "";
  const vendor = form.get("vendor") || "";
  const days = parseInt(form.get("days") || "30");
  const forceRefresh = form.get("forceRefresh") === "true";
  const cacheKey = `${locationGid}__${productType}__${vendor}__${days}`;

  try {
    if (!forceRefresh) {
      try {
        const cached = await db.snapshotCache.findFirst({
          where: {
            cacheKey,
            createdAt: { gt: new Date(Date.now() - 4 * 60 * 60 * 1000) },
          },
        });
        if (cached) {
          const cachedRows = Array.isArray(cached.rows) ? cached.rows : [];
          const cachedTypes = [...new Set(cachedRows.map(r => r.productType).filter(Boolean))].sort();
          const cachedVendors = [...new Set(cachedRows.map(r => r.vendor).filter(Boolean))].sort();
          return {
            rows: cachedRows,
            productTypes: cachedTypes,
            vendors: cachedVendors,
            lowCount: cached.lowCount,
            avgST: cached.avgST,
            totalUnits: cached.totalUnits,
            days,
            fromCache: true,
            cachedAt: cached.createdAt,
          };
        }
      } catch (e) {}
    }

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString();

    // Build filter clause — AND logic when both set
    const queryParts = [];
    if (productType) queryParts.push(`product_type:'${esc(productType)}'`);
    if (vendor) queryParts.push(`vendor:'${esc(vendor)}'`);
    const typeClause = queryParts.length > 0 ? queryParts.join(" AND ") : null;

    // ONE pass: variants + product info + stock at this location
    const rowsBase = [];
    let cursor = null;
    let hasNext = true;

    while (hasNext) {
      const json = await gql(admin, `
        query($cursor: String, $query: String, $locationId: ID!) {
          productVariants(first: 100, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id sku title
                product { title vendor productType }
                inventoryItem {
                  id
                  inventoryLevel(locationId: $locationId) {
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
        }
      `, { cursor, query: typeClause, locationId: locationGid });

      const page = json.data?.productVariants;
      hasNext = page?.pageInfo?.hasNextPage ?? false;
      cursor = page?.pageInfo?.endCursor ?? null;

      for (const e of page?.edges ?? []) {
        const v = e.node;
        const onHand = v.inventoryItem?.inventoryLevel?.quantities
          ?.find(q => q.name === "available")?.quantity ?? 0;
        rowsBase.push({
          variantId: v.id,
          sku: v.sku || "—",
          productTitle: v.product?.title ?? "",
          variantTitle: v.title === "Default Title" ? "" : v.title,
          vendor: v.product?.vendor ?? "",
          productType: v.product?.productType ?? "",
          onHand,
        });
      }
    }

    // Sales at this location in the period
    const soldMap = {};
    const locationNumericId = locationGid.split("/").pop();
    const orderQuery = `created_at:>${sinceStr} location_id:${locationNumericId}`;
    let oCursor = null;
    let oHasNext = true;

    while (oHasNext) {
      const json = await gql(admin, `
        query($cursor: String, $query: String!) {
          orders(first: 50, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                lineItems(first: 100) {
                  edges { node { quantity variant { id } } }
                }
              }
            }
          }
        }
      `, { cursor: oCursor, query: orderQuery });

      const page = json.data?.orders;
      oHasNext = page?.pageInfo?.hasNextPage ?? false;
      oCursor = page?.pageInfo?.endCursor ?? null;

      for (const o of page?.edges ?? []) {
        for (const li of o.node.lineItems.edges) {
          const vid = li.node.variant?.id;
          if (!vid) continue;
          soldMap[vid] = (soldMap[vid] ?? 0) + li.node.quantity;
        }
      }
    }

    const minMaxRecords = await db.minMax.findMany();
    const minMaxMap = {};
    for (const r of minMaxRecords) {
      minMaxMap[`${r.variantId}__${r.locationId}`] = r.minLevel;
    }

    const rows = rowsBase.map(r => {
      const unitsSold = soldMap[r.variantId] ?? 0;
      const total = r.onHand + unitsSold;
      const sellThrough = total > 0 ? Math.round((unitsSold / total) * 100) : null;
      const minLevel = minMaxMap[`${r.variantId}__${locationGid}`] ?? null;
      const isBelowMin = minLevel !== null && r.onHand < minLevel;
      const isOutOfStock = r.onHand <= 0 && unitsSold > 0;
      return { ...r, unitsSold, sellThrough, isBelowMin, isOutOfStock, minLevel };
    });

    rows.sort((a, b) => {
      if (a.isOutOfStock !== b.isOutOfStock) return a.isOutOfStock ? -1 : 1;
      if (a.isBelowMin !== b.isBelowMin) return a.isBelowMin ? -1 : 1;
      return (b.sellThrough ?? -1) - (a.sellThrough ?? -1);
    });

    const productTypes = [...new Set(rows.map(r => r.productType).filter(Boolean))].sort();
    const vendors = [...new Set(rows.map(r => r.vendor).filter(Boolean))].sort();
    const lowCount = rows.filter(r => r.isBelowMin || r.isOutOfStock).length;
    const withST = rows.filter(r => r.sellThrough !== null);
    const avgST = withST.length > 0
      ? Math.round(withST.reduce((s, r) => s + r.sellThrough, 0) / withST.length)
      : null;
    const totalUnits = rows.reduce((s, r) => s + r.unitsSold, 0);

    try {
      await db.snapshotCache.upsert({
        where: { cacheKey },
        update: { rows, lowCount, avgST, totalUnits, productTypes, createdAt: new Date() },
        create: { cacheKey, rows, lowCount, avgST, totalUnits, productTypes },
      });
    } catch (e) {
      console.error("Cache write failed:", e);
    }

    return { rows, lowCount, avgST, totalUnits, productTypes, vendors, days, fromCache: false };
  } catch (e) {
    console.error("Snapshot failed:", e);
    return { error: e?.message || String(e) };
  }
};

export default function Index() {
  const { locations, productCount, openPOs, lastSnapshot } = useLoaderData();
  const fetcher = useFetcher();

  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [productType, setProductType] = useState("");
  const [vendor, setVendor] = useState("");
  const [days, setDays] = useState("30");
  const [search, setSearch] = useState("");
  const [savedTypes, setSavedTypes] = useState([]);
  const [savedVendors, setSavedVendors] = useState([]);
  const [copyMsg, setCopyMsg] = useState("");

  // Merge new types/vendors into the dropdown lists instead of replacing them
  useEffect(() => {
    const t = fetcher.data?.productTypes ?? [];
    const v = fetcher.data?.vendors ?? [];
    if (t.length > 0) {
      setSavedTypes(prev => [...new Set([...prev, ...t])].sort());
    }
    if (v.length > 0) {
      setSavedVendors(prev => [...new Set([...prev, ...v])].sort());
    }
  }, [fetcher.data]);

  const isLoading = fetcher.state !== "idle";
  const result = fetcher.data;
  const errorMsg = result?.error ?? null;
  const rows = result?.rows ?? [];
  const listsLoaded = savedTypes.length > 0 || savedVendors.length > 0;

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const typeOptions = [
    { label: listsLoaded ? "All product types" : "All (run once to load list)", value: "" },
    ...savedTypes.map(t => ({ label: t, value: t })),
  ];
  const vendorOptions = [
    { label: listsLoaded ? "All vendors" : "All (run once to load list)", value: "" },
    ...savedVendors.map(v => ({ label: v, value: v })),
  ];
  const dayOptions = [
    { label: "Last 7 days", value: "7" },
    { label: "Last 30 days", value: "30" },
    { label: "Last 60 days", value: "60" },
    { label: "Last 90 days", value: "90" },
  ];

  function handleRun(force = false) {
    const fd = new FormData();
    fd.append("intent", "loadDashboard");
    fd.append("locationId", locationId);
    fd.append("productType", productType);
    fd.append("vendor", vendor);
    fd.append("days", days);
    fd.append("forceRefresh", force ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  }

  const filtered = rows.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (r.sku || "").toLowerCase().includes(q) ||
      (r.productTitle || "").toLowerCase().includes(q) ||
      (r.vendor || "").toLowerCase().includes(q)
    );
  });

  // ---------- Export helpers ----------
  function statusText(r) {
    if (r.isOutOfStock) return "Out of stock";
    if (r.isBelowMin) return `Low - min ${r.minLevel}`;
    return "OK";
  }

  function buildTable(sep) {
    const header = ["SKU", "Product", "Variant", "Vendor", "Type", "On hand",
      `Sold (${result?.days ?? days}d)`, "Sell-through %", "Status"];
    const clean = (val) => {
      const s = val === null || val === undefined ? "" : String(val);
      if (sep === ",") {
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }
      return s.replace(/[\t\n]/g, " ");
    };
    const lines = [header.map(clean).join(sep)];
    for (const r of filtered) {
      lines.push([
        r.sku, r.productTitle, r.variantTitle, r.vendor, r.productType,
        r.onHand, r.unitsSold, r.sellThrough ?? "", statusText(r),
      ].map(clean).join(sep));
    }
    return lines.join("\n");
  }

  function fileName() {
    const loc = locations.find(l => l.id === locationId)?.name ?? "location";
    const parts = [loc, productType, vendor, `${result?.days ?? days}d`]
      .filter(Boolean)
      .map(p => p.replace(/[^a-z0-9]+/gi, "-"));
    return `sell-through_${parts.join("_")}.csv`;
  }

  function handleDownload() {
    try {
      const blob = new Blob([buildTable(",")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setCopyMsg("Download blocked — use Copy table instead");
    }
  }

  async function handleCopy() {
    const text = buildTable("\t");
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg(`Copied ${filtered.length} rows`);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopyMsg(`Copied ${filtered.length} rows`);
      } catch (e2) {
        setCopyMsg("Copy failed");
      }
      document.body.removeChild(ta);
    }
    setTimeout(() => setCopyMsg(""), 4000);
  }
  // ------------------------------------

  function stBadge(pct) {
    if (pct === null) return <Badge tone="info">No sales</Badge>;
    if (pct >= 70) return <Badge tone="success">{pct}%</Badge>;
    if (pct >= 40) return <Badge tone="attention">{pct}%</Badge>;
    return <Badge>{pct}%</Badge>;
  }

  function invBadge(row) {
    if (row.isOutOfStock) return <Badge tone="critical">Out of stock</Badge>;
    if (row.isBelowMin) return <Badge tone="critical">Low — min {row.minLevel}</Badge>;
    return <Badge tone="success">OK</Badge>;
  }

  const tableRows = filtered.map(r => [
    <BlockStack gap="050">
      <Text variant="bodyMd" fontWeight="semibold">{r.productTitle}</Text>
      {r.variantTitle && <Text variant="bodySm" tone="subdued">{r.variantTitle}</Text>}
      <Text variant="bodySm" tone="subdued">{r.sku}</Text>
    </BlockStack>,
    r.vendor,
    r.productType || "—",
    r.onHand,
    r.unitsSold,
    stBadge(r.sellThrough),
    invBadge(r),
  ]);

  const lowCount = result?.lowCount ?? lastSnapshot?.lowCount ?? "—";

  function formatCachedAt(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  }

  return (
    <Page title="StockFlow Dashboard">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={4} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Total SKUs</Text>
                <Text variant="heading2xl">{productCount.toLocaleString()}</Text>
                <Text tone="subdued">across all locations</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Locations</Text>
                <Text variant="heading2xl">{locations.length}</Text>
                <Text tone="subdued">{locations.map(l => l.name).join(", ")}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Open POs</Text>
                <Text variant="heading2xl">{openPOs}</Text>
                <Text tone="subdued">purchase orders</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Stock Alerts</Text>
                <Text variant="heading2xl">{lowCount}</Text>
                <Text tone="subdued">
                  {result?.fromCache
                    ? `as of ${formatCachedAt(result.cachedAt)}`
                    : lastSnapshot
                    ? `as of ${formatCachedAt(lastSnapshot.createdAt)}`
                    : "run a snapshot below"}
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingSm">Sell-Through Snapshot</Text>
                {result?.fromCache && (
                  <InlineStack gap="200" blockAlign="center">
                    <Text tone="subdued" variant="bodySm">
                      Cached {formatCachedAt(result.cachedAt)}
                    </Text>
                    <Button size="slim" onClick={() => handleRun(true)}>Refresh</Button>
                  </InlineStack>
                )}
              </InlineStack>
              <InlineStack gap="300" wrap={false} blockAlign="end">
                <Box minWidth="180px">
                  <Select label="Location" options={locationOptions}
                    value={locationId} onChange={setLocationId} />
                </Box>
                <Box minWidth="180px">
                  <Select label="Product type" options={typeOptions}
                    value={productType} onChange={setProductType} />
                </Box>
                <Box minWidth="180px">
                  <Select label="Vendor" options={vendorOptions}
                    value={vendor} onChange={setVendor} />
                </Box>
                <Box minWidth="150px">
                  <Select label="Period" options={dayOptions}
                    value={days} onChange={setDays} />
                </Box>
                <Box paddingBlockStart="500">
                  <Button variant="primary" onClick={() => handleRun(false)} loading={isLoading}>
                    Run
                  </Button>
                </Box>
              </InlineStack>
              {!result && (
                <Text tone="subdued" variant="bodySm">
                  Run once with everything set to "All" to load the product type and vendor lists,
                  then narrow down. Results cache for 4 hours.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {errorMsg && !isLoading && (
          <Layout.Section>
            <Banner title="Snapshot failed" tone="critical">
              <Text>{errorMsg}</Text>
            </Banner>
          </Layout.Section>
        )}

        {isLoading && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400" align="center">
                <Spinner size="large" />
                <Text tone="subdued">
                  Pulling data… first run for this scope takes the longest.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {!isLoading && !errorMsg && rows.length > 0 && (
          <>
            <Layout.Section>
              <InlineGrid columns={4} gap="400">
                <Card>
                  <BlockStack gap="100">
                    <Text variant="headingLg">{rows.length.toLocaleString()}</Text>
                    <Text tone="subdued">SKUs in snapshot</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="100">
                    <Text variant="headingLg">
                      {result.avgST !== null ? `${result.avgST}%` : "—"}
                    </Text>
                    <Text tone="subdued">Avg sell-through ({result.days}d)</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="100">
                    <Text variant="headingLg">{result.lowCount}</Text>
                    <Text tone="subdued">Low / out of stock</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="100">
                    <Text variant="headingLg">{result.totalUnits.toLocaleString()}</Text>
                    <Text tone="subdued">Units sold ({result.days}d)</Text>
                  </BlockStack>
                </Card>
              </InlineGrid>
            </Layout.Section>

            {result.lowCount > 0 && (
              <Layout.Section>
                <Banner
                  title={`${result.lowCount} SKU${result.lowCount !== 1 ? "s" : ""} need attention`}
                  tone="warning"
                >
                  <Text>
                    {rows
                      .filter(r => r.isBelowMin || r.isOutOfStock)
                      .slice(0, 5)
                      .map(r => r.productTitle)
                      .join(", ")}
                    {result.lowCount > 5 ? ` and ${result.lowCount - 5} more…` : ""}
                  </Text>
                </Banner>
              </Layout.Section>
            )}

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <Box width="100%">
                      <TextField
                        label="" labelHidden
                        placeholder="Filter by SKU, product, or vendor…"
                        value={search} onChange={setSearch}
                        clearButton onClearButtonClick={() => setSearch("")}
                        autoComplete="off"
                      />
                    </Box>
                    <Button onClick={handleDownload}>Download CSV</Button>
                    <Button onClick={handleCopy}>Copy table</Button>
                  </InlineStack>
                  {copyMsg && (
                    <Text tone="subdued" variant="bodySm">{copyMsg}</Text>
                  )}
                  <Divider />
                  <DataTable
                    columnContentTypes={["text","text","text","numeric","numeric","text","text"]}
                    headings={["Product / SKU","Vendor","Type","On hand",`Sold (${result.days}d)`,"Sell-through","Status"]}
                    rows={tableRows}
                    footerContent={
                      filtered.length !== rows.length
                        ? `Showing ${filtered.length} of ${rows.length} SKUs`
                        : `${rows.length} SKUs`
                    }
                    truncate
                  />
                </BlockStack>
              </Card>
            </Layout.Section>
          </>
        )}

        {!isLoading && result && !errorMsg && rows.length === 0 && (
          <Layout.Section>
            <Card>
              <Text tone="subdued">
                No SKUs found. Try a different location, product type, or vendor.
              </Text>
            </Card>
          </Layout.Section>
        )}

      </Layout>
    </Page>
  );
}