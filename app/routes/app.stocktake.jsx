import { useState } from "react";
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

  // paginate all products just for vendor and type lists
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
  const { admin } = await authenticate.admin(request);
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
          vendor: p.vendor,
          productType: p.productType,
          sku: v.sku || "—",
          onHand: invMap[v.id]?.qty ?? 0,
          inventoryItemId: invMap[v.id]?.inventoryItemId ?? null,
        }))
      )
      .sort((a, b) => a.productTitle.localeCompare(b.productTitle));

    return { ok: true, rows };
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
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, pushed: true };
  }

  return { ok: false };
};

export default function Stocktake() {
  const { locations, vendors, types } = useLoaderData();
  const fetcher = useFetcher();

  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [vendorFilter, setVendorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loaded, setLoaded] = useState(false);

  const isSubmitting = fetcher.state !== "idle";

  if (fetcher.data?.rows && fetcher.data.rows !== rows) {
    setRows(fetcher.data.rows);
    setLoaded(true);
    setCounts({});
  }

  function handleLoadInventory() {
    setLoaded(false);
    setRows([]);
    setCounts({});
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

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const vendorOptions = [{ label: "All vendors", value: "" }, ...vendors.map(v => ({ label: v, value: v }))];
  const typeOptions = [{ label: "All product types", value: "" }, ...types.map(t => ({ label: t, value: t }))];

  const changedCount = rows.filter(r =>
    counts[r.variantId] !== undefined &&
    counts[r.variantId] !== "" &&
    Number(counts[r.variantId]) !== r.onHand
  ).length;

  const pushed = fetcher.data?.pushed;
  const pushErrors = fetcher.data?.errors;

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
              loading={isSubmitting}
            >
              Push {changedCount > 0 ? `${changedCount} ` : ""}changes to Shopify
            </Button>
          </span>
        }
        secondaryActions={[{ content: "🖨 Print count sheet", onAction: () => window.print() }]}
      >
        <Layout>
          <Layout.Section>

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
                        loading={isSubmitting}
                      >
                        Load inventory
                      </Button>
                    </div>
                  </InlineStack>
                  {loaded && (
                    <Text tone="subdued">{rows.length} SKUs loaded · {changedCount} counted</Text>
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

            {isSubmitting && fetcher.formData?.get("intent") === "fetchInventory" && (
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
                              <td style={{ padding: "8px 12px" }}><Text>{row.productTitle}</Text></td>
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