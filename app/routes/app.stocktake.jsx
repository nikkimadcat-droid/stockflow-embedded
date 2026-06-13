import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Button,
  Select,
  TextField,
  Text,
  Badge,
  Banner,
  Spinner,
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

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "fetchInventory") {
    const locationId = form.get("locationId");
    const vendorFilter = form.get("vendorFilter");
    const typeFilter = form.get("typeFilter");

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
                      title
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

    const variantIds = new Set();
    for (const p of filtered) {
      for (const { node: v } of p.variants.edges) {
        variantIds.add(v.id);
      }
    }

    const invMap = {};
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
                  item {
                    id
                    variant { id }
                  }
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
        const n = e.node;
        const vid = n.item?.variant?.id;
        if (vid && variantIds.has(vid)) {
          invMap[vid] = {
            qty: n.quantities?.[0]?.quantity ?? 0,
            inventoryItemId: n.item?.id,
          };
        }
      }
    }

    const rows = filtered
      .flatMap(p =>
        p.variants.edges.map(({ node: v }) => ({
          variantId: v.id,
          productTitle: p.title,
          variantTitle: v.title === "Default Title" ? "" : v.title,
          vendor: p.vendor,
          productType: p.productType,
          sku: v.sku || "—",
          onHand: invMap[v.id]?.qty ?? 0,
          inventoryItemId: invMap[v.id]?.inventoryItemId ?? null,
        }))
      )
      .sort((a, b) => a.productTitle.localeCompare(b.productTitle));

    return { ok: true, intent, rows };
  }

  if (intent === "pushAdjustments") {
    const locationId = form.get("locationId");
    const adjustments = JSON.parse(form.get("adjustments"));

    const changes = adjustments.map(a => ({
      inventoryItemId: a.inventoryItemId,
      locationId,
      quantity: Number(a.counted),
    }));

    const res = await admin.graphql(`
      mutation($input: InventorySetOnHandQuantitiesInput!) {
        inventorySetOnHandQuantities(input: $input) {
          userErrors { field message }
          inventoryAdjustmentGroup { id }
        }
      }
    `, {
      variables: {
        input: {
          reason: "correction",
          setQuantities: changes,
        },
      },
    });

    const json = await res.json();
    const errors = json.data?.inventorySetOnHandQuantities?.userErrors ?? [];
    if (errors.length > 0) return { ok: false, intent, errors };
    return { ok: true, intent, pushed: true };
  }

  if (intent === "saveStocktake") {
    const stocktakeId = form.get("stocktakeId") || null;
    const locationId = form.get("locationId");
    const locationName = form.get("locationName");
    const vendorFilter = form.get("vendorFilter") || null;
    const typeFilter = form.get("typeFilter") || null;
    const status = form.get("status") || "in_progress";
    const rows = JSON.parse(form.get("rows"));
    const counts = JSON.parse(form.get("counts"));

    const lineData = rows.map(r => ({
      variantId: r.variantId,
      inventoryItemId: r.inventoryItemId,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle || "",
      vendor: r.vendor,
      productType: r.productType,
      sku: r.sku,
      onHand: r.onHand,
      counted: counts[r.variantId] !== undefined && counts[r.variantId] !== ""
        ? Number(counts[r.variantId]) : null,
    }));

    let record;
    if (stocktakeId) {
      await db.stocktakeLine.deleteMany({ where: { stocktakeId } });
      record = await db.stocktake.update({
        where: { id: stocktakeId },
        data: {
          locationId, locationName, vendorFilter, typeFilter, status,
          lines: { create: lineData },
        },
      });
    } else {
      record = await db.stocktake.create({
        data: {
          shop: session.shop,
          locationId, locationName, vendorFilter, typeFilter, status,
          lines: { create: lineData },
        },
      });
    }
    return { ok: true, intent, saved: true, stocktakeId: record.id };
  }

  if (intent === "loadStocktake") {
    const stocktakeId = form.get("stocktakeId");
    const record = await db.stocktake.findUnique({
      where: { id: stocktakeId },
      include: { lines: true },
    });

    if (!record) return { ok: false, intent, error: "Stocktake not found" };

    const rows = record.lines.map(l => ({
      variantId: l.variantId,
      inventoryItemId: l.inventoryItemId,
      productTitle: l.productTitle,
      variantTitle: l.variantTitle,
      vendor: l.vendor,
      productType: l.productType,
      sku: l.sku,
      onHand: l.onHand,
    }));
    const counts = {};
    record.lines.forEach(l => {
      if (l.counted !== null && l.counted !== undefined) {
        counts[l.variantId] = String(l.counted);
      }
    });

    return {
      ok: true,
      intent,
      loadedStocktake: {
        id: record.id,
        locationId: record.locationId,
        vendorFilter: record.vendorFilter,
        typeFilter: record.typeFilter,
        status: record.status,
      },
      rows,
      counts,
    };
  }

  return { ok: false };
};

export default function Stocktake() {
  const { locations, vendors, types } = useLoaderData();
  const fetcher = useFetcher();
  const [searchParams] = useSearchParams();

  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [vendorFilter, setVendorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [stocktakeId, setStocktakeId] = useState(null);
  const [stocktakeStatus, setStocktakeStatus] = useState("in_progress");

  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    const loadId = searchParams.get("load");
    if (loadId) {
      const fd = new FormData();
      fd.append("intent", "loadStocktake");
      fd.append("stocktakeId", loadId);
      fetcher.submit(fd, { method: "post" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (fetcher.data?.intent === "fetchInventory" && fetcher.data.rows !== rows) {
    setRows(fetcher.data.rows);
    setLoaded(true);
    setCounts({});
    setStocktakeId(null);
    setStocktakeStatus("in_progress");
  }

  if (fetcher.data?.intent === "loadStocktake" && fetcher.data.loadedStocktake?.id !== stocktakeId) {
    const { loadedStocktake, rows: loadedRows, counts: loadedCounts } = fetcher.data;
    setStocktakeId(loadedStocktake.id);
    setStocktakeStatus(loadedStocktake.status);
    setLocationId(loadedStocktake.locationId);
    setVendorFilter(loadedStocktake.vendorFilter || "");
    setTypeFilter(loadedStocktake.typeFilter || "");
    setRows(loadedRows);
    setCounts(loadedCounts);
    setLoaded(true);
  }

  if (fetcher.data?.intent === "saveStocktake" && fetcher.data.saved && fetcher.data.stocktakeId !== stocktakeId) {
    setStocktakeId(fetcher.data.stocktakeId);
  }

  function handleLoadInventory() {
    setLoaded(false);
    setRows([]);
    setCounts({});
    setStocktakeId(null);
    setStocktakeStatus("in_progress");
    const fd = new FormData();
    fd.append("intent", "fetchInventory");
    fd.append("locationId", locationId);
    fd.append("vendorFilter", vendorFilter);
    fd.append("typeFilter", typeFilter);
    fetcher.submit(fd, { method: "post" });
  }

  function handleLocationChange(val) {
    setLocationId(val);
    setLoaded(false);
    setRows([]);
    setCounts({});
    setStocktakeId(null);
  }

  function handleCount(variantId, val) {
    setCounts(prev => ({ ...prev, [variantId]: val }));
  }

  function handlePush() {
    const adjustments = rows
      .filter(r => counts[r.variantId] !== undefined && counts[r.variantId] !== "")
      .map(r => ({
        inventoryItemId: r.inventoryItemId,
        counted: counts[r.variantId],
      }))
      .filter(a => a.inventoryItemId);

    if (adjustments.length === 0) return;
    if (!confirm(`Push ${adjustments.length} inventory adjustment(s) to Shopify?`)) return;

    const fd = new FormData();
    fd.append("intent", "pushAdjustments");
    fd.append("locationId", locationId);
    fd.append("adjustments", JSON.stringify(adjustments));
    fetcher.submit(fd, { method: "post" });
  }

  function handleSave(markCompleted) {
    const locationName = locations.find(l => l.id === locationId)?.name ?? "";
    const fd = new FormData();
    fd.append("intent", "saveStocktake");
    if (stocktakeId) fd.append("stocktakeId", stocktakeId);
    fd.append("locationId", locationId);
    fd.append("locationName", locationName);
    fd.append("vendorFilter", vendorFilter);
    fd.append("typeFilter", typeFilter);
    fd.append("status", markCompleted ? "completed" : "in_progress");
    fd.append("rows", JSON.stringify(rows));
    fd.append("counts", JSON.stringify(counts));
    fetcher.submit(fd, { method: "post" });
    if (markCompleted) setStocktakeStatus("completed");
  }

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const vendorOptions = [{ label: "All vendors", value: "" }, ...vendors.map(v => ({ label: v, value: v }))];
  const typeOptions = [{ label: "All product types", value: "" }, ...types.map(t => ({ label: t, value: t }))];

  const changedCount = rows.filter(r =>
    counts[r.variantId] !== undefined &&
    counts[r.variantId] !== "" &&
    Number(counts[r.variantId]) !== r.onHand
  ).length;

  const countedCount = rows.filter(r =>
    counts[r.variantId] !== undefined && counts[r.variantId] !== ""
  ).length;

  const pushed = fetcher.data?.intent === "pushAdjustments" && fetcher.data?.pushed;
  const pushErrors = fetcher.data?.intent === "pushAdjustments" ? fetcher.data?.errors : null;
  const saved = fetcher.data?.intent === "saveStocktake" && fetcher.data?.saved;
  const isFetchingInventory = isSubmitting && fetcher.formData?.get("intent") === "fetchInventory";
  const isLoadingSaved = isSubmitting && fetcher.formData?.get("intent") === "loadStocktake";

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          body { font-size: 12px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
          th { background: #f5f5f5; font-weight: bold; }
        }
        .print-only { display: none; }
      `}</style>

      <Page
        title="Stocktake"
        primaryAction={
          <span className="no-print">
            <Button
              variant="primary"
              onClick={handlePush}
              disabled={changedCount === 0 || isSubmitting}
              loading={isSubmitting && fetcher.formData?.get("intent") === "pushAdjustments"}
            >
              Push {changedCount > 0 ? `${changedCount} ` : ""}changes to Shopify
            </Button>
          </span>
        }
        secondaryActions={[
          { content: "🖨 Print count sheet", onAction: () => window.print() },
          { content: "View saved stocktakes", url: "/app/stocktakes" },
        ]}
      >
        <Layout>
          <Layout.Section>

            {isLoadingSaved && (
              <div className="no-print" style={{ marginBottom: "1rem" }}>
                <Banner tone="info">Loading saved stocktake…</Banner>
              </div>
            )}
            {fetcher.data?.intent === "loadStocktake" && fetcher.data?.ok === false && (
              <div className="no-print" style={{ marginBottom: "1rem" }}>
                <Banner tone="critical">{fetcher.data.error}</Banner>
              </div>
            )}
            {pushed && (
              <div className="no-print" style={{ marginBottom: "1rem" }}>
                <Banner tone="success">Inventory updated in Shopify successfully.</Banner>
              </div>
            )}
            {pushErrors?.length > 0 && (
              <div className="no-print" style={{ marginBottom: "1rem" }}>
                <Banner tone="critical">{pushErrors.map(e => e.message).join(", ")}</Banner>
              </div>
            )}
            {saved && (
              <div className="no-print" style={{ marginBottom: "1rem" }}>
                <Banner tone="success">
                  Stocktake saved{stocktakeStatus === "completed" ? " and marked completed" : ""}.
                </Banner>
              </div>
            )}

            <div className="no-print">
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="400" wrap>
                    <div style={{ minWidth: "200px" }}>
                      <Select
                        label="Location"
                        options={locationOptions}
                        value={locationId}
                        onChange={handleLocationChange}
                      />
                    </div>
                    <div style={{ minWidth: "200px" }}>
                      <Select
                        label="Vendor"
                        options={vendorOptions}
                        value={vendorFilter}
                        onChange={setVendorFilter}
                      />
                    </div>
                    <div style={{ minWidth: "200px" }}>
                      <Select
                        label="Product Type"
                        options={typeOptions}
                        value={typeFilter}
                        onChange={setTypeFilter}
                      />
                    </div>
                    <div style={{ paddingTop: "24px" }}>
                      <Button
                        variant="primary"
                        onClick={handleLoadInventory}
                        loading={isFetchingInventory}
                      >
                        Load inventory
                      </Button>
                    </div>
                  </InlineStack>
                  {loaded && (
                    <InlineStack gap="400" align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text tone="subdued">{rows.length} SKUs loaded · {countedCount} counted</Text>
                        {stocktakeId && (
                          <Badge tone={stocktakeStatus === "completed" ? "success" : "attention"}>
                            {stocktakeStatus === "completed" ? "Completed" : "In progress · saved"}
                          </Badge>
                        )}
                      </InlineStack>
                      <InlineStack gap="200">
                        <Button
                          onClick={() => handleSave(false)}
                          loading={isSubmitting && fetcher.formData?.get("intent") === "saveStocktake" && fetcher.formData?.get("status") !== "completed"}
                          disabled={isSubmitting}
                        >
                          {stocktakeId ? "Save progress" : "Save stocktake"}
                        </Button>
                        <Button
                          onClick={() => handleSave(true)}
                          loading={isSubmitting && fetcher.formData?.get("intent") === "saveStocktake" && fetcher.formData?.get("status") === "completed"}
                          disabled={isSubmitting}
                        >
                          Mark completed
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>
            </div>

            <div className="print-only" style={{ marginBottom: "16px" }}>
              <h2 style={{ margin: 0 }}>Stocktake Count Sheet</h2>
              <p style={{ margin: "4px 0" }}>
                Location: {locations.find(l => l.id === locationId)?.name ?? ""}
                {vendorFilter ? ` · Vendor: ${vendorFilter}` : ""}
                {typeFilter ? ` · Type: ${typeFilter}` : ""}
                {" · "}Date: {new Date().toLocaleDateString()}
              </p>
            </div>

            {isFetchingInventory && (
              <div className="no-print" style={{ textAlign: "center", padding: "2rem" }}>
                <Spinner size="large" />
                <div style={{ marginTop: "1rem" }}>
                  <Text>Loading inventory — this may take a moment for large vendors…</Text>
                </div>
              </div>
            )}

            {loaded && rows.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <Card>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                          <th style={{ padding: "8px 12px", textAlign: "left" }}><Text variant="headingSm">Product</Text></th>
                          <th style={{ padding: "8px 12px", textAlign: "left" }}><Text variant="headingSm">Vendor</Text></th>
                          <th style={{ padding: "8px 12px", textAlign: "left" }}><Text variant="headingSm">SKU</Text></th>
                          <th style={{ padding: "8px 12px", textAlign: "right" }}><Text variant="headingSm">On Hand</Text></th>
                          <th style={{ padding: "8px 12px", textAlign: "center" }}><Text variant="headingSm">Counted</Text></th>
                          <th style={{ padding: "8px 12px", textAlign: "right" }} className="no-print"><Text variant="headingSm">Variance</Text></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const counted = counts[row.variantId];
                          const variance = counted !== undefined && counted !== ""
                            ? Number(counted) - Number(row.onHand)
                            : null;
                          const hasVariance = variance !== null && variance !== 0;

                          return (
                            <tr
                              key={row.variantId}
                              style={{
                                borderBottom: "1px solid #f1f2f3",
                                background: hasVariance
                                  ? (variance < 0 ? "#fff4f4" : "#f4fff6")
                                  : "transparent",
                              }}
                            >
                              <td style={{ padding: "8px 12px" }}>
                                <Text>{row.productTitle}{row.variantTitle ? ` - ${row.variantTitle}` : ""}</Text>
                              </td>
                              <td style={{ padding: "8px 12px" }}><Text tone="subdued">{row.vendor}</Text></td>
                              <td style={{ padding: "8px 12px" }}><Text>{row.sku}</Text></td>
                              <td style={{ padding: "8px 12px", textAlign: "right" }}><Text>{row.onHand}</Text></td>
                              <td style={{ padding: "8px 12px", width: "110px" }}>
                                <TextField
                                  label=""
                                  labelHidden
                                  type="number"
                                  value={counted ?? ""}
                                  onChange={(val) => handleCount(row.variantId, val)}
                                  autoComplete="off"
                                  placeholder="—"
                                />
                              </td>
                              <td style={{ padding: "8px 12px", textAlign: "right" }} className="no-print">
                                {variance !== null && (
                                  <Badge tone={variance < 0 ? "critical" : variance > 0 ? "warning" : "success"}>
                                    {variance > 0 ? "+" : ""}{variance}
                                  </Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            )}

            {loaded && rows.length === 0 && (
              <div style={{ marginTop: "1rem" }}>
                <Card>
                  <Text tone="subdued">No products found for the selected filters.</Text>
                </Card>
              </div>
            )}

          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}