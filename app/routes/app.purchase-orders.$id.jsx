import { useState, useRef, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Button, Text, Badge, Modal, Select, TextField,
  Banner, Spinner,
} from "@shopify/polaris";

function statusBadge(status) {
  const map = { draft: "info", ordered: "warning", received: "success", cancelled: "critical" };
  return <Badge tone={map[status] ?? "info"}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}

function locationBadge(locationName) {
  if (!locationName) return null;
  const name = locationName.toLowerCase();
  let bg, color, border;
  if (name.includes("willy") || name.includes("ws")) {
    bg = "#fde8e8"; color = "#c0392b"; border = "#f5c6c6";
  } else if (name.includes("monroe") || name.includes("mn")) {
    bg = "#fef9e7"; color = "#b7950b"; border = "#f9e79f";
  } else if (name.includes("mineral") || name.includes("mpr") || name.includes("west")) {
    bg = "#f3e8fd"; color = "#6c3483"; border = "#d7b8f5";
  } else {
    bg = "#f0f0f0"; color = "#555"; border = "#ccc";
  }
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: "12px",
      background: bg,
      color,
      border: `1px solid ${border}`,
      fontSize: "12px",
      fontWeight: 600,
      letterSpacing: "0.01em",
    }}>
      {locationName}
    </span>
  );
}

function downloadCSV(po, onHandMap) {
  const rows = [
    ["PO Number", "Supplier", "Status", "Created"],
    [po.poNumber, po.supplier?.name ?? "", po.status, new Date(po.createdAt).toLocaleDateString("en-US")],
    [],
    ["Vendor", "Supplier Code", "Product", "SKU", "On Hand", "Qty (Eaches)", "Cases", "Unit Cost", "Line Total"],
    ...po.items.map((i) => {
      const cases = i.casePackSize > 1 ? Math.floor(i.qtyOrdered / i.casePackSize) : "";
      return [i.vendor ?? "", i.supplierCode ?? "", i.productTitle, i.sku, onHandMap?.[i.variantId] !== undefined ? onHandMap[i.variantId] : "", i.qtyOrdered, cases, i.qtyCost.toFixed(2), (i.qtyOrdered * i.qtyCost).toFixed(2)];
    }),
    [],
    ["", "", "", "TOTAL", "", "", "", "", po.items.reduce((s, i) => s + i.qtyOrdered * i.qtyCost, 0).toFixed(2)],
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${po.poNumber}.csv`; a.click();
  URL.revokeObjectURL(url);
}

export const loader = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const po = await db.purchaseOrder.findUnique({
    where: { id: params.id },
    include: { items: true, supplier: true },
  });
  if (!po || po.shop !== shop) throw new Response("Not found", { status: 404 });

  const vendorSuppliers = await db.vendorSupplier.findMany({ where: { shop, isPrimary: true } });
  const primaryVendorMap = {};
  for (const vs of vendorSuppliers) {
    if (!primaryVendorMap[vs.supplierId]) primaryVendorMap[vs.supplierId] = [];
    primaryVendorMap[vs.supplierId].push(vs.vendorName);
  }
  const locRes = await admin.graphql(`query { locations(first: 10) { edges { node { id name } } } }`);
  const locJson = await locRes.json();
  const locations = locJson.data.locations.edges.map((e) => e.node);
  return { po, locations, primaryVendorMap };
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const id = params.id;

  if (intent === "regenerate") {
    const po = await db.purchaseOrder.findUnique({ where: { id } });
    if (!po) return { ok: false };
    let items = [];
    if (po.mode === "minmax") {
      const supplierSkus = await db.supplierSku.findMany({ where: { shop, supplierId: po.supplierId } });
      const variantIds = supplierSkus.map((s) => s.variantId);
      if (variantIds.length > 0) {
        const minmaxRows = await db.minMax.findMany({ where: { shop, locationId: po.locationId, variantId: { in: variantIds } } });
        const onHandMap = {};
        let cursor = null, hasMore = true;
        while (hasMore) {
          const invRes = await admin.graphql(`
            query($locationId: ID!, $cursor: String) {
              location(id: $locationId) {
                inventoryLevels(first: 250, after: $cursor) {
                  pageInfo { hasNextPage endCursor }
                  edges { node { quantities(names: ["available"]) { quantity } item { variant { id title product { title vendor } } sku } } }
                }
              }
            }
          `, { variables: { locationId: po.locationId, cursor } });
          const invJson = await invRes.json();
          const levels = invJson.data?.location?.inventoryLevels;
          hasMore = levels?.pageInfo?.hasNextPage ?? false;
          cursor = levels?.pageInfo?.endCursor ?? null;
          for (const e of levels?.edges ?? []) {
            const n = e.node, vid = n.item?.variant?.id;
            if (vid) onHandMap[vid] = { qty: n.quantities?.[0]?.quantity ?? 0, productTitle: n.item?.variant?.product?.title ?? "", variantTitle: n.item?.variant?.title ?? "", vendor: n.item?.variant?.product?.vendor ?? "", sku: n.item?.sku ?? "" };
          }
        }
        for (const mm of minmaxRows) {
          const onHand = onHandMap[mm.variantId];
          if (!onHand || onHand.qty >= mm.minLevel) continue;
          const needed = mm.maxLevel - onHand.qty;
          if (needed <= 0) continue;
          const casePackSize = mm.casePackSize > 1 ? mm.casePackSize : 1;
          const qtyOrdered = casePackSize > 1 ? Math.ceil(needed / casePackSize) * casePackSize : needed;
          const skuRec = supplierSkus.filter((s) => s.variantId === mm.variantId).sort((a, b) => (b.supplierCode ? 1 : 0) - (a.supplierCode ? 1 : 0))[0];
          items.push({ variantId: mm.variantId, productTitle: onHand.productTitle, variantTitle: onHand.variantTitle, vendor: onHand.vendor, sku: onHand.sku, supplierCode: skuRec?.supplierCode ?? "", qtyOrdered, casePackSize, qtyCost: skuRec?.cost ?? 0 });
        }
      }
    }
    await db.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
    await db.purchaseOrder.update({
      where: { id },
      data: { updatedAt: new Date(), items: { create: items.map((i) => ({ variantId: i.variantId, productTitle: i.productTitle, variantTitle: i.variantTitle, vendor: i.vendor ?? "", sku: i.sku, supplierCode: i.supplierCode ?? "", qtyOrdered: Number(i.qtyOrdered), casePackSize: Number(i.casePackSize ?? 1), qtyCost: Number(i.qtyCost), updatedAt: new Date() })) } },
    });
    return { ok: true, regenerated: true };
  }

  if (intent === "searchProducts") {
    const query = form.get("query");
    const supplierId = form.get("supplierId");
    const supplierSkus = await db.supplierSku.findMany({ where: { shop, supplierId }, select: { variantId: true, supplierCode: true, cost: true } });
    const supplierSkuMap = new Map();
    for (const s of supplierSkus) {
      const existing = supplierSkuMap.get(s.variantId);
      if (!existing || (!existing.supplierCode && s.supplierCode)) supplierSkuMap.set(s.variantId, s);
    }
    if (supplierSkuMap.size === 0) return { ok: true, intent: "searchProducts", results: [] };
    const [titleRes, skuRes] = await Promise.all([
      admin.graphql(`query($query: String!) { products(first: 10, query: $query) { edges { node { title vendor variants(first: 20) { edges { node { id sku title inventoryItem { id unitCost { amount } } } } } } } }`, { variables: { query: `title:*${query}*` } }),
      admin.graphql(`query($query: String!) { productVariants(first: 10, query: $query) { edges { node { id sku title product { title vendor } inventoryItem { id unitCost { amount } } } } }`, { variables: { query: `sku:${query}*` } }),
    ]);
    const [titleJson, skuJson] = await Promise.all([titleRes.json(), skuRes.json()]);
    const seen = new Set(); const results = [];
    for (const { node: p } of titleJson.data?.products?.edges ?? []) {
      for (const { node: v } of p.variants.edges) {
        if (seen.has(v.id) || !supplierSkuMap.has(v.id)) continue;
        seen.add(v.id);
        const skuRec = supplierSkuMap.get(v.id);
        results.push({ id: v.id, sku: v.sku, productTitle: p.title, variantTitle: v.title === "Default Title" ? "" : v.title, vendor: p.vendor ?? "", supplierCode: skuRec?.supplierCode ?? "", cost: skuRec?.cost ?? parseFloat(v.inventoryItem?.unitCost?.amount ?? 0) });
      }
    }
    for (const { node: v } of skuJson.data?.productVariants?.edges ?? []) {
      if (seen.has(v.id) || !supplierSkuMap.has(v.id)) continue;
      seen.add(v.id);
      const skuRec = supplierSkuMap.get(v.id);
      results.push({ id: v.id, sku: v.sku, productTitle: v.product?.title ?? "", variantTitle: v.title === "Default Title" ? "" : v.title, vendor: v.product?.vendor ?? "", supplierCode: skuRec?.supplierCode ?? "", cost: skuRec?.cost ?? parseFloat(v.inventoryItem?.unitCost?.amount ?? 0) });
    }
    return { ok: true, intent: "searchProducts", results: results.slice(0, 10) };
  }

  if (intent === "addItem") {
    await db.purchaseOrderItem.create({
      data: {
        purchaseOrderId: id,
        variantId: form.get("variantId"),
        productTitle: form.get("productTitle"),
        variantTitle: form.get("variantTitle"),
        vendor: form.get("vendor") || "",
        sku: form.get("sku"),
        supplierCode: form.get("supplierCode") || "",
        qtyOrdered: Number(form.get("qtyOrdered")) || 1,
        casePackSize: Number(form.get("casePackSize")) || 1,
        qtyCost: Number(form.get("qtyCost")) || 0,
        updatedAt: new Date(),
      },
    });
    return { ok: true, intent: "addItem" };
  }

  if (intent === "fetchInventory") {
    const locationId = form.get("locationId");
    const variantIds = JSON.parse(form.get("variantIds") || "[]");
    if (!locationId || variantIds.length === 0) return { ok: true, intent: "fetchInventory", onHand: {}, inventoryItemIds: {} };
    const variantIdSet = new Set(variantIds);
    const onHand = {}, inventoryItemIds = {};
    let cursor = null, hasMore = true;
    while (hasMore) {
      const invRes = await admin.graphql(`
        query($locationId: ID!, $cursor: String) {
          location(id: $locationId) {
            inventoryLevels(first: 250, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges { node { quantities(names: ["available"]) { quantity } item { id variant { id } } } }
            }
          }
        }
      `, { variables: { locationId, cursor } });
      const invJson = await invRes.json();
      const levels = invJson.data?.location?.inventoryLevels;
      hasMore = levels?.pageInfo?.hasNextPage ?? false;
      cursor = levels?.pageInfo?.endCursor ?? null;
      for (const e of levels?.edges ?? []) {
        const vid = e.node?.item?.variant?.id, iid = e.node?.item?.id;
        if (vid && variantIdSet.has(vid)) { onHand[vid] = e.node.quantities?.[0]?.quantity ?? 0; inventoryItemIds[vid] = iid; }
      }
      if (Object.keys(onHand).length === variantIds.length) break;
    }
    return { ok: true, intent: "fetchInventory", onHand, inventoryItemIds };
  }

  if (intent === "adjustStock") {
    const variantId = form.get("variantId");
    const inventoryItemId = form.get("inventoryItemId");
    const locationId = form.get("locationId");
    const newQty = Number(form.get("newQty"));
    if (!inventoryItemId || !locationId) return { ok: false, intent: "adjustStock", error: "Missing inventory item or location" };
    const res = await admin.graphql(`
      mutation($input: InventorySetOnHandQuantitiesInput!) {
        inventorySetOnHandQuantities(input: $input) { userErrors { field message } inventoryAdjustmentGroup { id } }
      }
    `, { variables: { input: { reason: "correction", setQuantities: [{ inventoryItemId, locationId, quantity: newQty }] } } });
    const json = await res.json();
    const errors = json.data?.inventorySetOnHandQuantities?.userErrors ?? [];
    if (errors.length > 0) return { ok: false, intent: "adjustStock", variantId, error: errors.map(e => e.message).join(", ") };
    return { ok: true, intent: "adjustStock", variantId, newQty };
  }

  if (intent === "receive") {
    const po = await db.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
    if (!po || !po.locationId) return { ok: false, error: "PO not found or no location set" };
    const receiveQtys = JSON.parse(form.get("receiveQtys"));
    const inventoryItemMap = {};
    for (let i = 0; i < po.items.length; i += 50) {
      const batch = po.items.slice(i, i + 50).map((item) => item.variantId);
      const varRes = await admin.graphql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } } }`, { variables: { ids: batch } });
      const varJson = await varRes.json();
      for (const node of varJson.data?.nodes ?? []) { if (node?.id && node?.inventoryItem?.id) inventoryItemMap[node.id] = node.inventoryItem.id; }
    }
    const changes = [];
    for (const item of po.items) {
      const qty = Number(receiveQtys[item.id] ?? item.qtyOrdered);
      if (qty <= 0) continue;
      const inventoryItemId = inventoryItemMap[item.variantId];
      if (!inventoryItemId) continue;
      changes.push({ inventoryItemId, locationId: po.locationId, delta: qty });
    }
    if (changes.length === 0) return { ok: false, error: "No items to receive" };
    const errors = [];
    for (let i = 0; i < changes.length; i += 100) {
      const adjRes = await admin.graphql(`
        mutation($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message } } }
      `, { variables: { input: { reason: "received", name: "available", changes: changes.slice(i, i + 100) } } });
      const adjJson = await adjRes.json();
      errors.push(...(adjJson.data?.inventoryAdjustQuantities?.userErrors ?? []).map((e) => e.message));
    }
    if (errors.length > 0) return { ok: false, intent: "receive", error: errors.join("; ") };
    await db.purchaseOrder.update({ where: { id }, data: { status: "received", updatedAt: new Date() } });
    return { ok: true, intent: "receive" };
  }

  if (intent === "updateStatus") {
    const status = form.get("status");
    await db.purchaseOrder.update({ where: { id }, data: { status, updatedAt: new Date() } });
    return { ok: true };
  }

  if (intent === "updateItems") {
    const updates = JSON.parse(form.get("updates"));
    const removedIds = JSON.parse(form.get("removedIds") || "[]");
    if (removedIds.length > 0) await db.purchaseOrderItem.deleteMany({ where: { id: { in: removedIds } } });
    for (const u of updates) {
      const cost = parseFloat(u.qtyCost) || 0;
      await db.purchaseOrderItem.update({ where: { id: u.id }, data: { qtyOrdered: Number(u.qtyOrdered), supplierCode: u.supplierCode, qtyCost: cost, updatedAt: new Date() } });
      if (u.supplierId) await db.supplierSku.updateMany({ where: { shop, variantId: u.variantId, supplierId: u.supplierId }, data: { supplierCode: u.supplierCode, cost } });
      try {
        const varRes = await admin.graphql(`query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`, { variables: { id: u.variantId } });
        const varJson = await varRes.json();
        const inventoryItemId = varJson.data?.productVariant?.inventoryItem?.id;
        if (inventoryItemId) {
          await admin.graphql(`mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { field message } } }`, { variables: { id: inventoryItemId, input: { unitCost: { amount: cost.toString(), currencyCode: "USD" } } } });
        }
      } catch (err) { console.error("Cost sync failed:", err); }
    }
    return { ok: true, saved: true };
  }

  return { ok: false };
};

export default function PurchaseOrderDetail() {
  const { po: initialPo, locations, primaryVendorMap } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();

  const [itemEdits, setItemEdits] = useState({});
  const [removedItems, setRemovedItems] = useState(new Set());
  const [onHandData, setOnHandData] = useState(null);
  const [inventoryItemIds, setInventoryItemIds] = useState({});
  const [receiveModal, setReceiveModal] = useState(null);
  const [receiveError, setReceiveError] = useState(null);
  const [skuSearch, setSkuSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [selectedResult, setSelectedResult] = useState(null);
  const [skuQty, setSkuQty] = useState("1");
  const [skuCost, setSkuCost] = useState("0");
  const [stockAdjust, setStockAdjust] = useState({});

  const debounceTimer = useRef(null);
  const isSubmitting = fetcher.state !== "idle";
  const fetcherData = fetcher.data;
  const po = initialPo;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcherData?.intent === "fetchInventory" && onHandData === "loading") {
      setOnHandData(fetcherData.onHand);
      setInventoryItemIds(fetcherData.inventoryItemIds ?? {});
    }
  }, [fetcher.state, fetcherData]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcherData?.intent === "receive") {
      if (fetcherData.ok && receiveModal) { setReceiveModal(null); setReceiveError(null); }
      else if (!fetcherData.ok && fetcherData.error) setReceiveError(fetcherData.error);
    }
  }, [fetcher.state, fetcherData]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcherData?.intent === "searchProducts") {
      setSearchResults(fetcherData.results ?? []);
    }
  }, [fetcher.state, fetcherData]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcherData?.intent === "adjustStock" && fetcherData?.variantId) {
      const vid = fetcherData.variantId;
      if (fetcherData.ok && stockAdjust[vid]?.saving) {
        setStockAdjust((prev) => ({ ...prev, [vid]: { open: false, value: "", saving: false, saved: true, error: null } }));
        setOnHandData((prev) => ({ ...(prev ?? {}), [vid]: fetcherData.newQty }));
        setTimeout(() => setStockAdjust((prev) => ({ ...prev, [vid]: { ...prev[vid], saved: false } })), 2000);
      } else if (!fetcherData.ok && stockAdjust[vid]?.saving) {
        setStockAdjust((prev) => ({ ...prev, [vid]: { ...prev[vid], saving: false, error: fetcherData.error } }));
      }
    }
  }, [fetcher.state, fetcherData]);

  const locationNameMap = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  const locationName = po.locationId ? (locationNameMap[po.locationId] ?? "") : null;
  const primaryVendors = new Set(primaryVendorMap[po.supplierId] ?? []);
  const hasOnHand = onHandData && onHandData !== "loading";
  const isLoadingInventory = onHandData === "loading";
  const canReceive = po.status !== "received" && po.status !== "cancelled" && po.items.length > 0 && po.locationId;

  const statusOptions = [
    { label: "Draft", value: "draft" },
    { label: "Ordered", value: "ordered" },
    { label: "Received", value: "received" },
    { label: "Cancelled", value: "cancelled" },
  ];

  const displayItems = po.items.map((i) => ({
    ...i,
    qtyOrdered: itemEdits[i.id]?.qtyOrdered !== undefined ? Number(itemEdits[i.id].qtyOrdered) : i.qtyOrdered,
    supplierCode: itemEdits[i.id]?.supplierCode !== undefined ? itemEdits[i.id].supplierCode : (i.supplierCode ?? ""),
    qtyCost: itemEdits[i.id]?.qtyCost !== undefined ? Number(itemEdits[i.id].qtyCost) : i.qtyCost,
    removed: removedItems.has(i.id),
  }));

  const activeItems = displayItems.filter((i) => !i.removed);
  const totalCost = activeItems.reduce((s, i) => s + i.qtyOrdered * i.qtyCost, 0);
  const totalUnits = activeItems.reduce((s, i) => s + i.qtyOrdered, 0);
  const hasChanges = Object.keys(itemEdits).length > 0 || removedItems.size > 0;

  const vendorGroups = {};
  for (const item of displayItems) {
    const v = item.vendor || "Other";
    if (!vendorGroups[v]) vendorGroups[v] = [];
    vendorGroups[v].push(item);
  }
  const primaryGroups = {}, secondaryGroups = {};
  for (const [vendor, items] of Object.entries(vendorGroups)) {
    if (primaryVendors.size === 0 || primaryVendors.has(vendor)) primaryGroups[vendor] = items;
    else secondaryGroups[vendor] = items;
  }

  const tableHeaders = ["Supplier Code", "Product", "SKU", ...(hasOnHand ? ["On Hand"] : []), "Eaches", "Cases", "Unit Cost", "Line Total", ""];

  function handleSearchChange(val) {
    setSkuSearch(val);
    setSearchResults([]);
    setSelectedResult(null);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (!val.trim() || val.trim().length < 2) return;
    debounceTimer.current = setTimeout(() => {
      const fd = new FormData();
      fd.append("intent", "searchProducts");
      fd.append("query", val.trim());
      fd.append("supplierId", po.supplierId);
      fetcher.submit(fd, { method: "post" });
    }, 400);
  }

  function handleSelectResult(result) {
    setSelectedResult(result);
    setSearchResults([]);
    setSkuSearch(`${result.productTitle}${result.variantTitle ? ` - ${result.variantTitle}` : ""}`);
    setSkuQty("1");
    setSkuCost(String(result.cost));
  }

  function handleItemEdit(itemId, field, val) {
    setItemEdits((prev) => ({ ...prev, [itemId]: { ...prev[itemId], [field]: val } }));
  }

  function handleRemoveItem(itemId) {
    setRemovedItems((prev) => new Set([...prev, itemId]));
    setItemEdits((prev) => { const n = { ...prev }; delete n[itemId]; return n; });
  }

  function handleRemoveVendor(itemIds) {
    setRemovedItems((prev) => new Set([...prev, ...itemIds]));
    setItemEdits((prev) => { const n = { ...prev }; for (const id of itemIds) delete n[id]; return n; });
  }

  function handleRestoreItem(itemId) {
    setRemovedItems((prev) => { const s = new Set(prev); s.delete(itemId); return s; });
  }

  function handleSaveItems() {
    if (Object.keys(itemEdits).length === 0 && removedItems.size === 0) return;
    const updates = po.items.filter((i) => !removedItems.has(i.id) && itemEdits[i.id]).map((i) => ({
      id: i.id, variantId: i.variantId, supplierId: po.supplierId,
      qtyOrdered: itemEdits[i.id]?.qtyOrdered !== undefined ? itemEdits[i.id].qtyOrdered : i.qtyOrdered,
      supplierCode: itemEdits[i.id]?.supplierCode !== undefined ? itemEdits[i.id].supplierCode : (i.supplierCode ?? ""),
      qtyCost: itemEdits[i.id]?.qtyCost !== undefined ? itemEdits[i.id].qtyCost : i.qtyCost,
    }));
    const fd = new FormData();
    fd.append("intent", "updateItems");
    fd.append("updates", JSON.stringify(updates));
    fd.append("removedIds", JSON.stringify([...removedItems]));
    fetcher.submit(fd, { method: "post" });
    setItemEdits({});
    setRemovedItems(new Set());
  }

  function handleLoadInventory() {
    const variantIds = po.items.map((i) => i.variantId);
    if (!po.locationId || variantIds.length === 0) return;
    setOnHandData("loading");
    const fd = new FormData();
    fd.append("intent", "fetchInventory");
    fd.append("locationId", po.locationId);
    fd.append("variantIds", JSON.stringify(variantIds));
    fetcher.submit(fd, { method: "post" });
  }

  function handleRegenerate() {
    if (!confirm("Regenerate this PO? Current line items will be replaced with fresh inventory data.")) return;
    const fd = new FormData();
    fd.append("intent", "regenerate");
    fetcher.submit(fd, { method: "post" });
    setItemEdits({});
    setRemovedItems(new Set());
    setOnHandData(null);
  }

  function handleStatusChange(status) {
    const fd = new FormData();
    fd.append("intent", "updateStatus");
    fd.append("status", status);
    fetcher.submit(fd, { method: "post" });
  }

  function handleOpenReceive() {
    const receiveQtys = Object.fromEntries(
      activeItems.map((i) => [i.id, itemEdits[i.id]?.qtyOrdered !== undefined ? String(itemEdits[i.id].qtyOrdered) : String(i.qtyOrdered)])
    );
    setReceiveError(null);
    setReceiveModal({ receiveQtys });
  }

  function handleConfirmReceive() {
    const fd = new FormData();
    fd.append("intent", "receive");
    fd.append("receiveQtys", JSON.stringify(receiveModal.receiveQtys));
    fetcher.submit(fd, { method: "post" });
  }

  function handleAddItem() {
    if (!selectedResult) return;
    const fd = new FormData();
    fd.append("intent", "addItem");
    fd.append("variantId", selectedResult.id);
    fd.append("productTitle", selectedResult.productTitle);
    fd.append("variantTitle", selectedResult.variantTitle);
    fd.append("vendor", selectedResult.vendor ?? "");
    fd.append("sku", selectedResult.sku);
    fd.append("supplierCode", selectedResult.supplierCode);
    fd.append("qtyOrdered", skuQty);
    fd.append("casePackSize", "1");
    fd.append("qtyCost", skuCost);
    fetcher.submit(fd, { method: "post" });
    setSkuSearch(""); setSearchResults([]); setSelectedResult(null); setSkuQty("1"); setSkuCost("0");
  }

  function handleOpenStockAdjust(variantId, currentQty) {
    setStockAdjust((prev) => ({ ...prev, [variantId]: { open: true, value: String(currentQty ?? ""), saving: false, saved: false, error: null } }));
  }

  function handleCancelStockAdjust(variantId) {
    setStockAdjust((prev) => ({ ...prev, [variantId]: { open: false, value: "", saving: false, saved: false, error: null } }));
  }

  function handleConfirmStockAdjust(variantId, inventoryItemId, locationId) {
    const newQty = Number(stockAdjust[variantId]?.value);
    if (isNaN(newQty) || newQty < 0) return;
    setStockAdjust((prev) => ({ ...prev, [variantId]: { ...prev[variantId], saving: true, error: null } }));
    const fd = new FormData();
    fd.append("intent", "adjustStock");
    fd.append("variantId", variantId);
    fd.append("inventoryItemId", inventoryItemId);
    fd.append("locationId", locationId);
    fd.append("newQty", String(newQty));
    fetcher.submit(fd, { method: "post" });
  }

  function renderItemRow(item) {
    const qty = itemEdits[item.id]?.qtyOrdered !== undefined ? itemEdits[item.id].qtyOrdered : String(item.qtyOrdered);
    const supplierCode = itemEdits[item.id]?.supplierCode !== undefined ? itemEdits[item.id].supplierCode : (item.supplierCode ?? "");
    const cost = itemEdits[item.id]?.qtyCost !== undefined ? itemEdits[item.id].qtyCost : String(item.qtyCost);
    const lineTotal = (Number(qty) * Number(cost)).toFixed(2);
    const onHandQty = hasOnHand ? (onHandData[item.variantId] ?? 0) : null;
    const inventoryItemId = inventoryItemIds[item.variantId];
    const casePackSize = item.casePackSize ?? 1;
    const casesOrdered = casePackSize > 1 ? Math.floor(Number(qty) / casePackSize) : null;
    const adjust = stockAdjust[item.variantId];

    if (item.removed) {
      return (
        <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3", opacity: 0.4 }}>
          <td colSpan={hasOnHand ? 8 : 7} style={{ padding: "8px 12px" }}>
            <Text tone="subdued"><s>{item.productTitle}</s></Text>
          </td>
          <td style={{ padding: "8px 12px" }}>
            <Button variant="plain" onClick={() => handleRestoreItem(item.id)}>Restore</Button>
          </td>
        </tr>
      );
    }

    return (
      <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
        <td style={{ padding: "8px 12px", width: "130px" }}>
          <TextField label=" " labelHidden value={supplierCode} onChange={(val) => handleItemEdit(item.id, "supplierCode", val)} autoComplete="off" placeholder="—" />
        </td>
        <td style={{ padding: "8px 12px" }}><Text>{item.productTitle}</Text></td>
        <td style={{ padding: "8px 12px" }}><Text tone="subdued">{item.sku}</Text></td>
        {hasOnHand && (
          <td style={{ padding: "8px 12px", width: "140px" }}>
            {adjust?.open ? (
              <InlineStack gap="100" blockAlign="center">
                <div style={{ width: "90px" }}>
                  <TextField label=" " labelHidden type="number" value={adjust.value} onChange={(val) => setStockAdjust((prev) => ({ ...prev, [item.variantId]: { ...prev[item.variantId], value: val } }))} autoComplete="off" min="0" />
                </div>
                <Button size="slim" variant="primary" onClick={() => handleConfirmStockAdjust(item.variantId, inventoryItemId, po.locationId)} loading={adjust.saving} disabled={adjust.saving}>✓</Button>
                <Button size="slim" variant="plain" onClick={() => handleCancelStockAdjust(item.variantId)}>✕</Button>
              </InlineStack>
            ) : (
              <InlineStack gap="200" blockAlign="center">
                <Text tone={onHandQty <= 0 ? "critical" : onHandQty < 3 ? "caution" : "success"}>{onHandQty}</Text>
                {adjust?.saved && <Text tone="success" variant="bodySm">✓</Text>}
                {adjust?.error && <Text tone="critical" variant="bodySm">!</Text>}
                {inventoryItemId && <Button size="slim" variant="plain" onClick={() => handleOpenStockAdjust(item.variantId, onHandQty)}>Adjust</Button>}
              </InlineStack>
            )}
          </td>
        )}
        <td style={{ padding: "8px 12px", width: "100px" }}>
          <TextField label=" " labelHidden type="number" value={qty} onChange={(val) => handleItemEdit(item.id, "qtyOrdered", val)} autoComplete="off" />
        </td>
        <td style={{ padding: "8px 12px", width: "70px", textAlign: "center" }}>
          {casesOrdered !== null ? <Text tone="subdued">{casesOrdered}</Text> : <Text tone="subdued">—</Text>}
        </td>
        <td style={{ padding: "8px 12px", width: "150px" }}>
          <TextField label=" " labelHidden type="number" prefix="$" value={cost} onChange={(val) => handleItemEdit(item.id, "qtyCost", val)} autoComplete="off" />
        </td>
        <td style={{ padding: "8px 12px" }}><Text>${lineTotal}</Text></td>
        <td style={{ padding: "8px 12px" }}>
          <Button variant="plain" tone="critical" onClick={() => handleRemoveItem(item.id)}>Remove</Button>
        </td>
      </tr>
    );
  }

  function renderVendorGroup(vendor, items, isSecondary) {
    const activeGroupIds = items.filter((i) => !i.removed).map((i) => i.id);
    return (
      <BlockStack key={vendor} gap="100">
        <div style={{ background: isSecondary ? "#fff8f0" : "#f6f6f7", padding: "6px 12px", borderRadius: "6px" }}>
          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="200" blockAlign="center">
              <Text variant="headingSm">{vendor}</Text>
              {isSecondary && <Badge tone="warning">Not primary</Badge>}
              <Text tone="subdued" variant="bodySm">{activeGroupIds.length} SKU{activeGroupIds.length !== 1 ? "s" : ""}</Text>
            </InlineStack>
            {activeGroupIds.length > 0 && (
              <Button variant="plain" tone="critical" onClick={() => handleRemoveVendor(activeGroupIds)}>Remove all</Button>
            )}
          </InlineStack>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
              {tableHeaders.map((h, i) => (
                <th key={i} style={{ padding: "8px 12px", textAlign: i >= (hasOnHand ? 4 : 3) && i <= (hasOnHand ? 5 : 4) ? "center" : "left" }}>
                  <Text variant="headingSm">{h}</Text>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{items.map((item) => renderItemRow(item))}</tbody>
        </table>
      </BlockStack>
    );
  }

  const isDuplicate = selectedResult && po.items.some((i) => i.variantId === selectedResult.id && !removedItems.has(i.id));
  const isSearching = isSubmitting && fetcher.formData?.get("intent") === "searchProducts";

  return (
    <Page
      title={po.poNumber}
      backAction={{ content: "Purchase Orders", onAction: () => navigate("/app/purchase-orders") }}
      secondaryActions={[
        { content: "↓ CSV", onAction: () => downloadCSV({ ...po, items: activeItems }, hasOnHand ? onHandData : null) },
        ...(po.mode !== "manual" ? [{ content: "↺ Regenerate", onAction: handleRegenerate }] : []),
      ]}
      primaryAction={canReceive ? { content: "✓ Receive", onAction: handleOpenReceive } : undefined}
    >
      <Layout>
        <Layout.Section>

          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  {statusBadge(po.status)}
                  {locationName && locationBadge(locationName)}
                  <Badge tone="default">{po.mode}</Badge>
                </InlineStack>
                <Text tone="subdued">{po.supplier?.name} · {activeItems.length} SKUs · {totalUnits} units · ${totalCost.toFixed(2)}</Text>
                <Text tone="subdued" variant="bodySm">
                  Created {new Date(po.createdAt).toLocaleDateString("en-US")}
                  {po.notes ? ` · ${po.notes}` : ""}
                </Text>
              </BlockStack>
              <InlineStack gap="200" blockAlign="center">
                <Select label=" " labelHidden options={statusOptions} value={po.status} onChange={handleStatusChange} />
                {po.locationId && (
                  <Button variant="plain" onClick={handleLoadInventory} loading={isLoadingInventory} disabled={isLoadingInventory}>
                    {hasOnHand ? "↺ Refresh on-hand" : "Load on-hand qty"}
                  </Button>
                )}
              </InlineStack>
            </InlineStack>
          </Card>

          {receiveModal && (
            <Modal
              open
              onClose={() => { setReceiveModal(null); setReceiveError(null); }}
              title={`Receive ${po.poNumber}`}
              primaryAction={{ content: "Receive & Update Shopify Inventory", onAction: handleConfirmReceive, loading: isSubmitting, disabled: isSubmitting }}
              secondaryActions={[{ content: "Cancel", onAction: () => { setReceiveModal(null); setReceiveError(null); } }]}
            >
              <Modal.Section>
                <BlockStack gap="400">
                  <Text>Receiving at: <strong>{locationName}</strong></Text>
                  <Text tone="subdued">Adjust quantities below if you received a partial shipment.</Text>
                  {receiveError && <Banner tone="critical">{receiveError}</Banner>}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                          {["Product", "SKU", "Qty to Receive"].map((h, i) => (
                            <th key={i} style={{ padding: "8px 12px", textAlign: "left" }}><Text variant="headingSm">{h}</Text></th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {activeItems.map((item) => (
                          <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                            <td style={{ padding: "8px 12px" }}><Text>{item.productTitle}</Text></td>
                            <td style={{ padding: "8px 12px" }}><Text>{item.sku}</Text></td>
                            <td style={{ padding: "8px 12px", width: "110px" }}>
                              <TextField label=" " labelHidden type="number" value={receiveModal.receiveQtys[item.id] ?? String(item.qtyOrdered)} onChange={(val) => setReceiveModal((prev) => ({ ...prev, receiveQtys: { ...prev.receiveQtys, [item.id]: val } }))} autoComplete="off" min="0" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </BlockStack>
              </Modal.Section>
            </Modal>
          )}

          {po.items.length === 0 ? (
            <Card>
              <Banner tone="info">No items on this PO yet. Use the search below to add items manually.</Banner>
            </Card>
          ) : (
            <Card>
              <BlockStack gap="400">
                {hasOnHand && (
                  <Banner tone="info">
                    Live on-hand at {locationName} — click Adjust next to any item to correct the count.
                  </Banner>
                )}
                {Object.entries(primaryGroups).sort(([a], [b]) => a.localeCompare(b)).map(([vendor, items]) =>
                  renderVendorGroup(vendor, items, false)
                )}
                {Object.keys(secondaryGroups).length > 0 && (
                  <BlockStack gap="300">
                    <div style={{ padding: "8px 12px", background: "#fff4e5", borderRadius: "6px" }}>
                      <Text variant="headingSm" tone="subdued">Backup / Secondary source</Text>
                    </div>
                    {Object.entries(secondaryGroups).sort(([a], [b]) => a.localeCompare(b)).map(([vendor, items]) =>
                      renderVendorGroup(vendor, items, true)
                    )}
                  </BlockStack>
                )}
                <div style={{ borderTop: "2px solid #e1e3e5", padding: "8px 12px" }}>
                  <InlineStack align="space-between">
                    <Text variant="headingSm">Total</Text>
                    <InlineStack gap="600">
                      <Text variant="headingSm">{totalUnits} units</Text>
                      <Text variant="headingSm">${totalCost.toFixed(2)}</Text>
                    </InlineStack>
                  </InlineStack>
                </div>
                {hasChanges && (
                  <InlineStack align="end">
                    <Button variant="primary" onClick={handleSaveItems}>Save changes</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          )}

          <Card>
            <BlockStack gap="300">
              <Text variant="headingSm">Add item</Text>
              <TextField
                label="Search by product name or SKU"
                labelHidden
                value={skuSearch}
                onChange={handleSearchChange}
                autoComplete="off"
                placeholder="Type product name or SKU..."
                suffix={isSearching ? <Spinner size="small" /> : undefined}
              />
              {searchResults.length > 0 && (
                <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: "4px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)", maxHeight: "300px", overflowY: "auto" }}>
                  {searchResults.map((result) => {
                    const alreadyOnPO = po.items.some((i) => i.variantId === result.id && !removedItems.has(i.id));
                    return (
                      <div
                        key={result.id}
                        onClick={() => handleSelectResult(result)}
                        style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #f1f2f3", background: alreadyOnPO ? "#fff4e5" : "#fff" }}
                        onMouseEnter={(e) => e.currentTarget.style.background = alreadyOnPO ? "#ffe8cc" : "#f6f6f7"}
                        onMouseLeave={(e) => e.currentTarget.style.background = alreadyOnPO ? "#fff4e5" : "#fff"}
                      >
                        <InlineStack align="space-between">
                          <Text fontWeight="semibold">{result.productTitle}{result.variantTitle ? ` — ${result.variantTitle}` : ""}</Text>
                          {alreadyOnPO && <Badge tone="warning">Already on PO</Badge>}
                        </InlineStack>
                        <Text tone="subdued" variant="bodySm">SKU: {result.sku} · ${result.cost.toFixed(2)}{result.supplierCode ? ` · Code: ${result.supplierCode}` : ""}</Text>
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedResult && (
                <Card>
                  <BlockStack gap="300">
                    {isDuplicate && <Banner tone="warning">This SKU is already on this PO. Adding it again will create a duplicate line item.</Banner>}
                    <BlockStack gap="100">
                      <Text fontWeight="semibold">{selectedResult.productTitle}{selectedResult.variantTitle ? ` — ${selectedResult.variantTitle}` : ""}</Text>
                      <Text tone="subdued">SKU: {selectedResult.sku}{selectedResult.supplierCode ? ` · Code: ${selectedResult.supplierCode}` : ""}</Text>
                    </BlockStack>
                    <InlineStack gap="300" blockAlign="end">
                      <div style={{ width: "100px" }}>
                        <TextField label="Qty (eaches)" type="number" value={skuQty} onChange={setSkuQty} autoComplete="off" min="1" />
                      </div>
                      <div style={{ width: "120px" }}>
                        <TextField label="Unit cost" type="number" prefix="$" value={skuCost} onChange={setSkuCost} autoComplete="off" />
                      </div>
                      <Button variant="primary" onClick={handleAddItem} loading={isSubmitting && fetcher.formData?.get("intent") === "addItem"}>Add to PO</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Card>

        </Layout.Section>
      </Layout>
    </Page>
  );
}