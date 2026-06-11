import { useState, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page, Layout, Card, Text, BlockStack, InlineGrid,
  InlineStack, Select, Button, Spinner, Badge, Banner,
  DataTable, TextField, Divider, Box,
} from "@shopify/polaris";

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

  if (!forceRefresh) {
    try {
      const cached = await db.snapshotCache.findFirst({
        where: {
          cacheKey,
          createdAt: { gt: new Date(Date.now() - 4 * 60 * 60 * 1000) },
        },
      });
      if (cached) {
        return {
          rows: cached.rows,
          productTypes: cached.productTypes,
          vendors: cached.vendors ?? [],
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

  // Build query clause — AND logic when both set
  let queryParts = [];
  if (productType) queryParts.push(`product_type:'${productType}'`);
  if (vendor) queryParts.push(`vendor:'${vendor}'`);
  const typeClause = queryParts.length > 0 ? queryParts.join(" AND ") : null;

  let products = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const res = await admin.graphql(`
      query($cursor: String, $query: String) {
        products(first: 50, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id title vendor productType
              variants(first: 50) {
                edges { node { id sku title inventoryItem { id } } }
              }
            }
          }
        }
      }
    `, { variables: { cursor, query: typeClause } });

    const json = await res.json();
    const page = json.data?.products;
    hasNext = page?.pageInfo?.hasNextPage ?? false;
    cursor = page?.pageInfo?.endCursor ?? null;
    products = products.concat(page?.edges?.map(e => e.node) ?? []);
  }

  const variantMap = {};
  const inventoryItemIds = [];
  for (const p of products) {
    for (const ve of p.variants.edges) {
      const v = ve.node;
      variantMap[v.id] = {
        sku: v.sku,
        productTitle: p.title,
        variantTitle: v.title === "Default Title" ? "" : v.title,
        vendor: p.vendor,
        productType: p.productType,
        inventoryItemId: v.inventoryItem?.id,
      };
      if (v.inventoryItem?.id) inventoryItemIds.push(v.inventoryItem.id);
    }
  }

  const onHandMap = {};
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    const batch = inventoryItemIds.slice(i, i + 50);
    const idsQuery = batch.map(id => `id:${id.split("/").pop()}`).join(" OR ");
    const res = await admin.graphql(`
      query($ids: String!, $locationId: ID!) {
        inventoryItems(first: 50, query: $ids) {
          edges {
            node {
              id
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    `, { variables: { ids: idsQuery, locationId: locationGid } });

    const json = await res.json();
    for (const e of json.data?.inventoryItems?.edges ?? []) {
      const qty = e.node.inventoryLevel?.quantities
        ?.find(q => q.name === "available")?.quantity ?? 0;
      onHandMap[e.node.id] = qty;
    }
  }

  const soldMap = {};
  const locationNumericId = locationGid.split("/").pop();
  const orderQuery = `created_at:>${sinceStr} location_id:${locationNumericId}`;
  let oCursor = null;
  let oHasNext = true;

  while (oHasNext) {
    const res = await admin.graphql(`
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
    `, { variables: { cursor: oCursor, query: orderQuery } });

    const json = await res.json();
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

  const rows = [];
  for (const [variantId, info] of Object.entries(variantMap)) {
    const onHand = onHandMap[info.inventoryItemId] ?? 0;
    const unitsSold = soldMap[variantId] ?? 0;
    const total = onHand + unitsSold;
    const sellThrough = total > 0 ? Math.round((unitsSold / total) * 100) : null;
    const minKey = `${variantId}__${locationGid}`;
    const minLevel = minMaxMap[minKey] ?? null;
    const isBelowMin = minLevel !== null && onHand < minLevel;
    const isOutOfStock = onHand <= 0 && unitsSold > 0;

    rows.push({
      variantId, sku: info.sku || "—",
      productTitle: info.productTitle,
      variantTitle: info.variantTitle,
      vendor: info.vendor,
      productType: info.productType,
      onHand, unitsSold, sellThrough,
      isBelowMin, isOutOfStock, minLevel,
    });
  }

  rows.sort((a, b) => {
    if (a.isOutOfStock !== b.isOutOfStock) return a.isOutOfStock ? -1 : 1;
    if (a.isBelowMin !== b.isBelowMin) return a.isBelowMin ? -1 : 1;
    return (b.sellThrough ?? -1) - (a.sellThrough ?? -1);
  });

  const productTypes = [...new Set(rows.map(r => r.productType).filter(Boolean))].sort();
  const vendors = [...new Set(rows.map(r => r.vendor).filter(Boolean))].sort();
  const lowCount = rows.filter(r => r.isBelowMin || r.isOutOfStock).length;
  const avgST = rows.filter(r => r.sellThrough !== null).length > 0
    ? Math.round(
        rows.filter(r => r.sellThrough !== null)
          .reduce((s, r) => s + r.sellThrough, 0) /
        rows.filter(r => r.sellThrough !== null).length
      )
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

  useEffect(() => {
    if (fetcher.data?.productTypes?.length > 0) {
      setSavedTypes(fetcher.data.productTypes);
    }
    if (fetcher.data?.vendors?.length > 0) {
      setSavedVendors(fetcher.data.vendors);
    }
  }, [fetcher.data]);

  const isLoading = fetcher.state !== "idle";
  const result = fetcher.data;
  const rows = result?.rows ?? [];

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const typeOptions = [
    { label: "All product types", value: "" },
    ...savedTypes.map(t => ({ label: t, value: t })),
  ];
  const vendorOptions = [
    { label: "All vendors", value: "" },
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
      r.sku.toLowerCase().includes(q) ||
      r.productTitle.toLowerCase().includes(q) ||
      r.vendor.toLowerCase().includes(q)
    );
  });

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
                  Filter by location, product type, vendor, or any combination. Results cache for 4 hours.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

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

        {!isLoading && rows.length > 0 && (
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
                  <TextField
                    label="" labelHidden
                    placeholder="Filter by SKU, product, or vendor…"
                    value={search} onChange={setSearch}
                    clearButton onClearButtonClick={() => setSearch("")}
                    autoComplete="off"
                  />
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

        {!isLoading && result && rows.length === 0 && (
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