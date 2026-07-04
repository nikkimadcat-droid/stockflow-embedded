import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useSearchParams, useNavigate, Link } from "react-router";
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
  IndexTable,
  EmptyState,
} from "@shopify/polaris";

// Normalize a Shopify location GID or numeric ID to just the numeric string
function normalizeLocationId(id) {
  if (!id) return id;
  if (String(id).includes("/")) return String(id).split("/").pop();
  return String(id);
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  if (url.searchParams.get("view") === "list") {
    const stocktakes = await db.stocktake.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lines: true } } },
    });
    return { view: "list", stocktakes };
  }

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
          edges { node { vendor productType hasVariantsThatRequiresComponents } }
        }
      }
    `, { variables: { cursor } });
    const json = await res.json();
    const page = json.data.products;
    for (const { node: p } of page.edges) {
      if (p.hasVariantsThatRequiresComponents) continue;
      if (p.vendor) vendors.add(p.vendor);
      if (p.productType) types.add(p.productType);
    }
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return {
    view: "stocktake",
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
    const shop = session.shop;

    const locationIdGid = locationId.includes("gid://")
      ? locationId
      : `gid://shopify/Location/${locationId}`;
    const locationIdNumeric = normalizeLocationId(locationId);

    const minmaxRows = await db.minMax.findMany({
      where: {
        shop,
        locationId: { in: [locationIdGid, locationIdNumeric] },
        OR: [{ minLevel: { gt: 0 } }, { maxLevel: { gt: 0 } }],
      },
      select: { variantId: true },
    });

    if (minmaxRows.length === 0) {
      return { ok: true, intent, rows: [] };
    }

    const variantGids = minmaxRows.map(m => m.variantId);

    const rowsMap = {};
    const chunkSize = 100;

    for (let i = 0; i < variantGids.length; i += chunkSize) {
      const chunk = variantGids.slice(i, i + chunkSize);
      const res = await admin.graphql(`
        query($ids: [ID!]!, $locationId: ID!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              sku
              title
              inventoryItem {
                id
                inventoryLevel(locationId: $locationId) {
                  quantities(names: ["available"]) { quantity }
                }
              }
              product {
                title
                vendor
                productType
                hasVariantsThatRequiresComponents
              }
            }
          }
        }
      `, { variables: { ids: chunk, locationId: locationIdGid } });

      const json = await res.json();
      for (const node of json.data?.nodes ?? []) {
        if (!node) continue;
        const p = node.product;
        if (!p || p.hasVariantsThatRequiresComponents) continue;
        if (vendorFilter && p.vendor !== vendorFilter) continue;
        if (typeFilter && p.productType !== typeFilter) continue;

        rowsMap[node.id] = {
          variantId: node.id,
          productTitle: p.title,
          variantTitle: node.title === "Default Title" ? "" : node.title,
          vendor: p.vendor,
          productType: p.productType,
          sku: node.sku || "—",
          onHand: node.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? 0,
          inventoryItemId: node.inventoryItem?.id ?? null,
        };
      }
    }

    const rows = Object.values(rowsMap).sort((a, b) =>
      a.productTitle.localeCompare(b.productTitle)
    );

    return { ok: true, intent, rows };
  }

  if (intent === "searchProducts") {
    const query = form.get("query");
    const locationId = form.get("locationId");
    const locationIdGid = locationId.includes("gid://")
      ? locationId
      : `gid://shopify/Location/${locationId}`;

    const [titleRes, skuRes] = await Promise.all([
      admin.graphql(`
        query($query: String!, $locationId: ID!) {
          products(first: 10, query: $query) {
            edges {
              node {
                title vendor productType hasVariantsThatRequiresComponents
                variants(first: 20) {
                  edges {
                    node {
                      id sku title
                      inventoryItem {
                        id
                        inventoryLevel(locationId: $locationId) {
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
      `, { variables: { query: `title:*${query}*`, locationId: locationIdGid } }),
      admin.graphql(`
        query($query: String!, $locationId: ID!) {
          productVariants(first: 10, query: $query) {
            edges {
              node {
                id sku title
                product { title vendor productType hasVariantsThatRequiresComponents }
                inventoryItem {
                  id
                  inventoryLevel(locationId: $locationId) {
                    quantities(names: ["available"]) { quantity }
                  }
                }
              }
            }
          }
        }
      `, { variables: { query: `sku:*${query}*`, locationId: locationIdGid } }),
    ]);

    const [titleJson, skuJson] = await Promise.all([titleRes.json(), skuRes.json()]);
    const seen = new Set();
    const results = [];

    for (const { node: p } of titleJson.data?.products?.edges ?? []) {
      if (p.hasVariantsThatRequiresComponents) continue;
      for (const { node: v } of p.variants.edges) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        results.push({
          variantId: v.id,
          productTitle: p.title,
          variantTitle: v.title === "Default Title" ? "" : v.title,
          vendor: p.vendor ?? "",
          productType: p.productType ?? "",
          sku: v.sku || "—",
          onHand: v.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? 0,
          inventoryItemId: v.inventoryItem?.id ?? null,
        });
      }
    }

    for (const { node: v } of skuJson.data?.productVariants?.edges ?? []) {
      if (seen.has(v.id) || v.product?.hasVariantsThatRequiresComponents) continue;
      seen.add(v.id);
      results.push({
        variantId: v.id,
        productTitle: v.product?.title ?? "",
        variantTitle: v.title === "Default Title" ? "" : v.title,
        vendor: v.product?.vendor ?? "",
        productType: v.product?.productType ?? "",
        sku: v.sku || "—",
        onHand: v.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? 0,
        inventoryItemId: v.inventoryItem?.id ?? null,
      });
    }

    return { ok: true, intent, results: results.slice(0, 10) };
  }

  if (intent === "pushAdjustments") {
    const locationId = form.get("locationId");
    const locationIdGid = locationId.includes("gid://")
      ? locationId
      : `gid://shopify/Location/${locationId}`;
    const adjustments = JSON.parse(form.get("adjustments"));

    const changes = adjustments.map(a => ({
      inventoryItemId: a.inventoryItemId,
      locationId: locationIdGid,
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

  if (intent === "saveStocktake" || intent === "autoSaveStocktake") {
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

const AUTO_SAVE_EVERY = 10;

function SavedStocktakesList({ stocktakes }) {
  return (
    <Card>
      {stocktakes.length === 0 ? (
        <EmptyState heading="No saved stocktakes yet" image="">
          <p>Saved and completed stocktakes will appear here.</p>
        </EmptyState>
      ) : (
        <IndexTable
          itemCount={stocktakes.length}
          headings={[
            { title: "Date" },
            { title: "Location" },
            { title: "Filters" },
            { title: "SKUs" },
            { title: "Status" },
            { title: "" },
          ]}
          selectable={false}
        >
          {stocktakes.map((s, i) => (
            <IndexTable.Row id={s.id} key={s.id} position={i}>
              <IndexTable.Cell>
                <Text>{new Date(s.createdAt).toLocaleString()}</Text>
              </IndexTable.Cell>
              <IndexTable.Cell>{s.locationName}</IndexTable.Cell>
              <IndexTable.Cell>
                {[s.vendorFilter, s.typeFilter].filter(Boolean).join(" / ") || "—"}
              </IndexTable.Cell>
              <IndexTable.Cell>{s._count.lines}</IndexTable.Cell>
              <IndexTable.Cell>
                <Badge tone={s.status === "completed" ? "success" : "attention"}>
                  {s.status === "completed" ? "Completed" : "In progress"}
                </Badge>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Link to={`/app/stocktake?load=${s.id}`}>Open</Link>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      )}
    </Card>
  );
}

export default function Stocktake() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const autoSaveFetcher = useFetcher();
  const searchFetcher = useFetcher();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const isListView = data.view === "list";

  const locations = isListView ? [] : data.locations;
  const vendors = isListView ? [] : data.vendors;
  const types = isListView ? [] : data.types;

  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [vendorFilter, setVendorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [stocktakeId, setStocktakeId] = useState(null);
  const [stocktakeStatus, setStocktakeStatus] = useState("in_progress");
  const [lastAutoSaveMsg, setLastAutoSaveMsg] = useState(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const searchDebounceRef = useRef(null);

  const countsSinceLastSave = useRef(0);
  const liveStateRef = useRef({});

  const isSubmitting = fetcher.state !== "idle";
  const isSearching = searchFetcher.state !== "idle";

  useEffect(() => {
    liveStateRef.current = { rows, counts, locationId, vendorFilter, typeFilter, stocktakeId, locations };
  }, [rows, counts, locationId, vendorFilter, typeFilter, stocktakeId, locations]);

  useEffect(() => {
    if (isListView) return;
    const loadId = searchParams.get("load");
    if (loadId) {
      const fd = new FormData();
      fd.append("intent", "loadStocktake");
      fd.append("stocktakeId", loadId);
      fetcher.submit(fd, { method: "post" });
    }
  }, [searchParams]);

  if (!isListView && fetcher.data?.intent === "fetchInventory" && fetcher.data.rows !== rows) {
    setRows(fetcher.data.rows);
    setLoaded(true);
    setCounts({});
    setStocktakeId(null);
    setStocktakeStatus("in_progress");
    countsSinceLastSave.current = 0;
  }

  if (!isListView && fetcher.data?.intent === "loadStocktake" && fetcher.data.loadedStocktake?.id !== stocktakeId) {
    const { loadedStocktake, rows: loadedRows, counts: loadedCounts } = fetcher.data;
    setStocktakeId(loadedStocktake.id);
    setStocktakeStatus(loadedStocktake.status);
    setLocationId(loadedStocktake.locationId);
    setVendorFilter(loadedStocktake.vendorFilter || "");
    setTypeFilter(loadedStocktake.typeFilter || "");
    setRows(loadedRows);
    setCounts(loadedCounts);
    setLoaded(true);
    countsSinceLastSave.current = 0;
  }

  if (!isListView && fetcher.data?.intent === "saveStocktake" && fetcher.data.saved && fetcher.data.stocktakeId !== stocktakeId) {
    setStocktakeId(fetcher.data.stocktakeId);
    countsSinceLastSave.current = 0;
  }

  if (!isListView && autoSaveFetcher.data?.intent === "autoSaveStocktake" && autoSaveFetcher.data?.saved) {
    if (autoSaveFetcher.data.stocktakeId !== stocktakeId) {
      setStocktakeId(autoSaveFetcher.data.stocktakeId);
      countsSinceLastSave.current = 0;
    }
    if (autoSaveFetcher.data.stocktakeId && lastAutoSaveMsg !== autoSaveFetcher.data.stocktakeId + autoSaveFetcher.data.ts) {
      setLastAutoSaveMsg(autoSaveFetcher.data.stocktakeId + autoSaveFetcher.data.ts);
    }
  }

  if (!isListView && searchFetcher.data?.intent === "searchProducts" && searchFetcher.data.results !== searchResults) {
    setSearchResults(searchFetcher.data.results ?? []);
  }

  function triggerAutoSave(currentStocktakeId, currentRows, currentCounts, currentLocationId, currentVendorFilter, currentTypeFilter, currentLocations) {
    const locationName = currentLocations.find(l => l.id === currentLocationId)?.name ?? "";
    const fd = new FormData();
    fd.append("intent", "autoSaveStocktake");
    if (currentStocktakeId) fd.append("stocktakeId", currentStocktakeId);
    fd.append("locationId", currentLocationId);
    fd.append("locationName", locationName);
    fd.append("vendorFilter", currentVendorFilter);
    fd.append("typeFilter", currentTypeFilter);
    fd.append("status", "in_progress");
    fd.append("rows", JSON.stringify(currentRows));
    fd.append("counts", JSON.stringify(currentCounts));
    autoSaveFetcher.submit(fd, { method: "post" });
  }

  if (isListView) {
    return (
      <Page title="Saved Stocktakes" backAction={{ content: "Stocktake", onAction: () => navigate("/app/stocktake") }}>
        <Layout>
          <Layout.Section>
            <SavedStocktakesList stocktakes={data.stocktakes} />
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  function handleLoadInventory() {
    setLoaded(false);
    setRows([]);
    setCounts({});
    setStocktakeId(null);
    setStocktakeStatus("in_progress");
    countsSinceLastSave.current = 0;
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
    countsSinceLastSave.current = 0;
    setSearchQuery("");
    setSearchResults([]);
  }

  function handleSearchChange(val) {
    setSearchQuery(val);
    setSearchResults([]);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!val.trim() || val.trim().length < 2) return;
    searchDebounceRef.current = setTimeout(() => {
      const fd = new FormData();
      fd.append("intent", "searchProducts");
      fd.append("query", val.trim());
      fd.append("locationId", locationId);
      searchFetcher.submit(fd, { method: "post" });
    }, 400);
  }

  function handleAddSearchedItem(result) {
    const alreadyOnList = rows.some(r => r.variantId === result.variantId);
    if (!alreadyOnList) {
      setRows(prev => [...prev, result].sort((a, b) => a.productTitle.localeCompare(b.productTitle)));
    }
    setLoaded(true);
    setSearchQuery("");
    setSearchResults([]);
  }

  function handleCount(variantId, val) {
    setCounts(prev => {
      const updated = { ...prev, [variantId]: val };

      countsSinceLastSave.current += 1;
      if (countsSinceLastSave.current >= AUTO_SAVE_EVERY && autoSaveFetcher.state === "idle") {
        countsSinceLastSave.current = 0;
        const { rows: r, locationId: lid, vendorFilter: vf, typeFilter: tf, stocktakeId: sid, locations: locs } = liveStateRef.current;
        triggerAutoSave(sid, r, updated, lid, vf, tf, locs);
      }

      return updated;
    });
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
    countsSinceLastSave.current = 0;
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
  const isAutoSaving = autoSaveFetcher.state !== "idle";
  const autoSaved = autoSaveFetcher.data?.intent === "autoSaveStocktake" && autoSaveFetcher.data?.saved;

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
          { content: "View saved stocktakes", onAction: () => navigate("/app/stocktake?view=list") },
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

                  <div style={{ position: "relative", maxWidth: "400px" }}>
                    <TextField
                      label="Add a single SKU"
                      value={searchQuery}
                      onChange={handleSearchChange}
                      autoComplete="off"
                      placeholder="Search by product name or SKU..."
                      suffix={isSearching ? <Spinner size="small" /> : undefined}
                      clearButton
                      onClearButtonClick={() => { setSearchQuery(""); setSearchResults([]); }}
                    />
                    {searchResults.length > 0 && (
                      <div style={{
                        position: "absolute", zIndex: 10, top: "100%", left: 0, right: 0,
                        background: "#fff", border: "1px solid #e1e3e5", borderRadius: "4px",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.1)", maxHeight: "300px",
                        overflowY: "auto", marginTop: "4px",
                      }}>
                        {searchResults.map((result) => {
                          const alreadyOnList = rows.some(r => r.variantId === result.variantId);
                          return (
                            <div
                              key={result.variantId}
                              onClick={() => handleAddSearchedItem(result)}
                              style={{
                                padding: "10px 14px", cursor: "pointer",
                                borderBottom: "1px solid #f1f2f3",
                                background: alreadyOnList ? "#fff4e5" : "#fff",
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.background = alreadyOnList ? "#ffe8cc" : "#f6f6f7"}
                              onMouseLeave={(e) => e.currentTarget.style.background = alreadyOnList ? "#fff4e5" : "#fff"}
                            >
                              <InlineStack align="space-between">
                                <Text fontWeight="semibold">
                                  {result.productTitle}{result.variantTitle ? ` — ${result.variantTitle}` : ""}
                                </Text>
                                {alreadyOnList && <Badge tone="warning">Already added</Badge>}
                              </InlineStack>
                              <Text tone="subdued" variant="bodySm">
                                SKU: {result.sku} · {result.vendor} · On hand: {result.onHand}
                              </Text>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {loaded && (
                    <InlineStack gap="400" align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text tone="subdued">{rows.length} SKUs loaded · {countedCount} counted</Text>
                        {stocktakeId && (
                          <Badge tone={stocktakeStatus === "completed" ? "success" : "attention"}>
                            {stocktakeStatus === "completed" ? "Completed" : "In progress · saved"}
                          </Badge>
                        )}
                        {isAutoSaving && (
                          <Text tone="subdued" variant="bodySm">Auto-saving…</Text>
                        )}
                        {!isAutoSaving && autoSaved && (
                          <Text tone="subdued" variant="bodySm">✓ Auto-saved</Text>
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
                  <Text tone="subdued">No products found for the selected filters. This location may have no min/max levels set, or no products matching the selected vendor/type.</Text>
                </Card>
              </div>
            )}

          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}