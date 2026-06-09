import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Select,
  TextField,
  Banner,
  Spinner,
} from "@shopify/polaris";
import { useState, useCallback } from "react";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const locResponse = await admin.graphql(`
    query {
      locations(first: 10) {
        edges { node { id name } }
      }
    }
  `);
  const locData = await locResponse.json();
  const locations = locData.data.locations.edges.map(e => e.node);

  // paginate just vendor and product type for filters
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
    shop,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "fetchProducts") {
    const locationId = formData.get("locationId");
    const vendorFilter = formData.get("vendorFilter");
    const typeFilter = formData.get("typeFilter");

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
                variants(first: 100) {
                  edges {
                    node { id sku }
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

    // paginate inventory levels for this location
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
          invMap[vid] = e.node.quantities?.[0]?.quantity ?? 0;
        }
      }
    }

    // get saved min/max for these variants at this location
    const savedMinMax = await db.minMax.findMany({
      where: { shop, locationId, variantId: { in: [...variantIds] } },
    });
    const minMaxMap = {};
    for (const mm of savedMinMax) {
      minMaxMap[mm.variantId] = mm;
    }

    // build rows sorted alphabetically
    const rows = filtered
      .flatMap(p =>
        p.variants.edges.map(({ node: v }) => ({
          variantId: v.id,
          productTitle: p.title,
          vendor: p.vendor,
          sku: v.sku || "—",
          onHand: invMap[v.id] ?? 0,
          minLevel: minMaxMap[v.id]?.minLevel ?? 0,
          maxLevel: minMaxMap[v.id]?.maxLevel ?? 0,
          casePackSize: minMaxMap[v.id]?.casePackSize ?? 1,
        }))
      )
      .sort((a, b) => a.productTitle.localeCompare(b.productTitle));

    return { ok: true, rows, locationId };
  }

  if (intent === "save") {
    const updates = JSON.parse(formData.get("updates"));
    const locationId = formData.get("locationId");

    for (const u of updates) {
      await db.minMax.upsert({
        where: {
          shop_variantId_locationId: {
            shop,
            variantId: u.variantId,
            locationId,
          },
        },
        update: {
          minLevel: parseInt(u.minLevel) || 0,
          maxLevel: parseInt(u.maxLevel) || 0,
          casePackSize: parseInt(u.casePackSize) || 1,
        },
        create: {
          shop,
          variantId: u.variantId,
          locationId,
          minLevel: parseInt(u.minLevel) || 0,
          maxLevel: parseInt(u.maxLevel) || 0,
          casePackSize: parseInt(u.casePackSize) || 1,
        },
      });

      // sync case pack across all locations
      if (u.casePackSize) {
        await db.minMax.updateMany({
          where: {
            shop,
            variantId: u.variantId,
            NOT: { locationId },
          },
          data: { casePackSize: parseInt(u.casePackSize) || 1 },
        });
      }
    }

    return { ok: true, saved: true };
  }

  return { ok: false };
};

export default function MinMax() {
  const { locations, vendors, types } = useLoaderData();
  const fetcher = useFetcher();

  const [selectedLocation, setSelectedLocation] = useState(locations[0]?.id || "");
  const [vendorFilter, setVendorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [loadedLocationId, setLoadedLocationId] = useState("");

  const isSubmitting = fetcher.state !== "idle";
  const isSaving = isSubmitting && fetcher.formData?.get("intent") === "save";
  const isLoading = isSubmitting && fetcher.formData?.get("intent") === "fetchProducts";

  if (fetcher.data?.rows && fetcher.data.rows !== rows) {
    setRows(fetcher.data.rows);
    setLoadedLocationId(fetcher.data.locationId);
    setLoaded(true);
    setEdits({});
  }

  const saved = fetcher.data?.saved && !isSubmitting;

  function handleLoad() {
    setLoaded(false);
    setRows([]);
    setEdits({});
    const fd = new FormData();
    fd.append("intent", "fetchProducts");
    fd.append("locationId", selectedLocation);
    fd.append("vendorFilter", vendorFilter);
    fd.append("typeFilter", typeFilter);
    fetcher.submit(fd, { method: "POST" });
  }

  const handleChange = useCallback((variantId, field, value) => {
    setEdits(prev => ({
      ...prev,
      [variantId]: { ...prev[variantId], [field]: value },
    }));
  }, []);

  function handleSave() {
    const updates = rows
      .filter(r => edits[r.variantId])
      .map(r => ({
        variantId: r.variantId,
        minLevel: edits[r.variantId]?.minLevel ?? r.minLevel,
        maxLevel: edits[r.variantId]?.maxLevel ?? r.maxLevel,
        casePackSize: edits[r.variantId]?.casePackSize ?? r.casePackSize,
      }));

    if (updates.length === 0) return;
    const fd = new FormData();
    fd.append("intent", "save");
    fd.append("locationId", loadedLocationId);
    fd.append("updates", JSON.stringify(updates));
    fetcher.submit(fd, { method: "POST" });
    setEdits({});
  }

  function getValue(variantId, field) {
    if (edits[variantId]?.[field] !== undefined) return edits[variantId][field];
    const row = rows.find(r => r.variantId === variantId);
    return String(row?.[field] ?? (field === "casePackSize" ? 1 : 0));
  }

  function getStatus(variantId, onHand) {
    const min = parseInt(edits[variantId]?.minLevel ?? rows.find(r => r.variantId === variantId)?.minLevel ?? 0);
    if (min === 0) return "—";
    if (onHand <= min) return "⚠️ Reorder";
    return "OK";
  }

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const vendorOptions = [{ label: "All vendors", value: "" }, ...vendors.map(v => ({ label: v, value: v }))];
  const typeOptions = [{ label: "All product types", value: "" }, ...types.map(t => ({ label: t, value: t }))];
  const hasEdits = Object.keys(edits).length > 0;

  return (
    <Page
      title="Min / Max Levels"
      primaryAction={
        <Button
          variant="primary"
          onClick={handleSave}
          loading={isSaving}
          disabled={!hasEdits}
        >
          Save changes
        </Button>
      }
    >
      <Layout>
        <Layout.Section>

          {saved && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner tone="success">Saved successfully.</Banner>
            </div>
          )}

          {/* filters */}
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400" wrap>
                <div style={{ minWidth: "200px" }}>
                  <Select
                    label="Location"
                    options={locationOptions}
                    value={selectedLocation}
                    onChange={val => { setSelectedLocation(val); setLoaded(false); setRows([]); }}
                  />
                </div>
                <div style={{ minWidth: "200px" }}>
                  <Select
                    label="Vendor"
                    options={vendorOptions}
                    value={vendorFilter}
                    onChange={val => { setVendorFilter(val); if (val) setTypeFilter(""); }}
                  />
                </div>
                <div style={{ minWidth: "200px" }}>
                  <Select
                    label="Product Type"
                    options={typeOptions}
                    value={typeFilter}
                    onChange={val => { setTypeFilter(val); if (val) setVendorFilter(""); }}
                  />
                </div>
                <div style={{ paddingTop: "24px" }}>
                  <Button
                    variant="primary"
                    onClick={handleLoad}
                    loading={isLoading}
                  >
                    Load products
                  </Button>
                </div>
              </InlineStack>
              {loaded && (
                <Text tone="subdued">{rows.length} SKUs loaded</Text>
              )}
            </BlockStack>
          </Card>

          {/* loading */}
          {isLoading && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <div style={{ marginTop: "1rem" }}>
                <Text>Loading products and inventory…</Text>
              </div>
            </div>
          )}

          {/* table */}
          {loaded && !isLoading && rows.length > 0 && (
            <Card>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      {["Product", "SKU", "On Hand", "Min", "Max", "Case Pack", "Status"].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>
                          <Text variant="headingSm">{h}</Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const status = getStatus(row.variantId, row.onHand);
                      return (
                        <tr key={row.variantId} style={{ borderBottom: "1px solid #f1f2f3" }}>
                          <td style={{ padding: "8px 12px" }}>
                            <Text>{row.productTitle}</Text>
                            <Text tone="subdued" variant="bodySm">{row.vendor}</Text>
                          </td>
                          <td style={{ padding: "8px 12px" }}>
                            <Text>{row.sku}</Text>
                          </td>
                          <td style={{ padding: "8px 12px" }}>
                            <Text>{row.onHand}</Text>
                          </td>
                          <td style={{ padding: "8px 12px", width: "100px" }}>
                            <TextField
                              label=""
                              labelHidden
                              type="number"
                              value={getValue(row.variantId, "minLevel")}
                              onChange={val => handleChange(row.variantId, "minLevel", val)}
                              autoComplete="off"
                            />
                          </td>
                          <td style={{ padding: "8px 12px", width: "100px" }}>
                            <TextField
                              label=""
                              labelHidden
                              type="number"
                              value={getValue(row.variantId, "maxLevel")}
                              onChange={val => handleChange(row.variantId, "maxLevel", val)}
                              autoComplete="off"
                            />
                          </td>
                          <td style={{ padding: "8px 12px", width: "100px" }}>
                            <TextField
                              label=""
                              labelHidden
                              type="number"
                              value={getValue(row.variantId, "casePackSize")}
                              onChange={val => handleChange(row.variantId, "casePackSize", val)}
                              autoComplete="off"
                            />
                          </td>
                          <td style={{ padding: "8px 12px" }}>
                            <Text tone={status === "⚠️ Reorder" ? "critical" : "subdued"}>
                              {status}
                            </Text>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {loaded && !isLoading && rows.length === 0 && (
            <Card>
              <Text tone="subdued">No products found for the selected filters.</Text>
            </Card>
          )}

        </Layout.Section>
      </Layout>
    </Page>
  );
}