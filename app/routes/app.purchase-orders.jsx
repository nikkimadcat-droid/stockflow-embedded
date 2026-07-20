// v6 - Eligibility for min/max PO generation, sales-velocity PO generation,
// and the manual "Add item" search is now driven by the Vendor -> Supplier
// mapping (VendorSupplier), not by whether a SupplierSku row happens to
// exist. SupplierSku is now purely optional enrichment (cost/supplier code).
// This closes the gap where a brand-new Shopify item — tagged with a vendor
// that's already mapped to a supplier, with a min/max set — would silently
// never appear on a PO because nothing had created a SupplierSku row for it.
//
// "Received" can no longer be set from the status dropdown or via a raw
// updateStatus call; it can only be set by the Receive button, which also
// runs the Shopify inventory delta adjustment. This closes the gap where a
// PO could be marked received without ever updating on-hand stock.
import { useState, useRef, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Button,
  Text,
  Badge,
  Modal,
  Select,
  TextField,
  Divider,
  Banner,
  EmptyState,
  Spinner,
} from "@shopify/polaris";

function poNumberGen() {
  const d = new Date();
  return `PO-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 900) + 100}`;
}

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
    [po.poNumber, po.supplier?.name ?? "", po.status, new Date(po.createdAt).toLocaleDateString()],
    [],
    ["Vendor", "Supplier Code", "Product", "SKU", "On Hand", "Qty (Eaches)", "Cases", "Unit Cost", "Line Total"],
    ...po.items.map((i) => {
      const cases = i.casePackSize > 1 ? Math.floor(i.qtyOrdered / i.casePackSize) : "";
      return [
        i.vendor ?? "",
        i.supplierCode ?? "",
        i.productTitle,
        i.sku,
        onHandMap?.[i.variantId] !== undefined ? onHandMap[i.variantId] : "",
        i.qtyOrdered,
        cases,
        i.qtyCost.toFixed(2),
        (i.qtyOrdered * i.qtyCost).toFixed(2),
      ];
    }),
    [],
    ["", "", "", "TOTAL", "", "", "", "", po.items.reduce((s, i) => s + i.qtyOrdered * i.qtyCost, 0).toFixed(2)],
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${po.poNumber}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function bestSkuRec(supplierSkus, variantId) {
  const matches = supplierSkus.filter((s) => s.variantId === variantId);
  if (matches.length === 0) return null;
  return matches.sort((a, b) => (b.supplierCode ? 1 : 0) - (a.supplierCode ? 1 : 0))[0];
}

async function buildMinmaxItems(admin, db, shop, supplierId, locationId) {
  // Eligibility is driven by vendor -> supplier mapping (VendorSupplier),
  // not by whether a SupplierSku row happens to exist. A brand new item
  // just needs a min/max set + its Shopify vendor mapped to a supplier —
  // no manual SupplierSku entry required.
  const minmaxRows = await db.minMax.findMany({
    where: { shop, locationId },
  });
  if (minmaxRows.length === 0) return [];

  const vendorLinks = await db.vendorSupplier.findMany({ where: { shop, supplierId } });
  const vendorNames = new Set(vendorLinks.map((v) => v.vendorName));
  if (vendorNames.size === 0) return [];

  // SupplierSku is now optional — only used to enrich cost/supplierCode
  // when available. A missing row no longer hides an otherwise-eligible item.
  const supplierSkus = await db.supplierSku.findMany({ where: { shop, supplierId } });

  const onHandMap = {};
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const invRes = await admin.graphql(`
      query($locationId: ID!, $cursor: String) {
        location(id: $locationId) {
          inventoryLevels(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                quantities(names: ["available"]) { quantity }
                item { variant { id title product { title vendor } } sku }
              }
            }
          }
        }
      }
    `, { variables: { locationId, cursor } });
    const invJson = await invRes.json();
    const levels = invJson.data?.location?.inventoryLevels;
    hasMore = levels?.pageInfo?.hasNextPage ?? false;
    cursor = levels?.pageInfo?.endCursor ?? null;
    for (const e of levels?.edges ?? []) {
      const n = e.node;
      const vid = n.item?.variant?.id;
      if (vid) onHandMap[vid] = {
        qty: n.quantities?.[0]?.quantity ?? 0,
        productTitle: n.item?.variant?.product?.title ?? "",
        variantTitle: n.item?.variant?.title ?? "",
        vendor: n.item?.variant?.product?.vendor ?? "",
        sku: n.item?.sku ?? "",
      };
    }
  }

  const items = [];
  for (const mm of minmaxRows) {
    const onHand = onHandMap[mm.variantId];
    if (!onHand) continue;
    if (!vendorNames.has(onHand.vendor)) continue; // vendor not mapped to this supplier
    if (onHand.qty > mm.minLevel) continue;
    const needed = mm.maxLevel - onHand.qty;
    if (needed <= 0) continue;
    const casePackSize = mm.casePackSize > 1 ? mm.casePackSize : 1;
    const qtyOrdered = casePackSize > 1 ? Math.ceil(needed / casePackSize) * casePackSize : needed;
    const skuRec = bestSkuRec(supplierSkus, mm.variantId);
    items.push({
      variantId: mm.variantId,
      productTitle: onHand.productTitle,
      variantTitle: onHand.variantTitle,
      vendor: onHand.vendor,
      sku: onHand.sku,
      supplierCode: skuRec?.supplierCode ?? "",
      qtyOrdered,
      casePackSize,
      qtyCost: skuRec?.cost ?? 0,
    });
  }
  return items;
}

async function buildSalesItems(admin, db, shop, supplierId) {
  // Same fix as buildMinmaxItems: eligibility comes from vendor -> supplier
  // mapping, not from a pre-existing SupplierSku row.
  const vendorLinks = await db.vendorSupplier.findMany({ where: { shop, supplierId } });
  const vendorNames = new Set(vendorLinks.map((v) => v.vendorName));
  if (vendorNames.size === 0) return [];

  const supplierSkus = await db.supplierSku.findMany({ where: { shop, supplierId } });

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString();
  let cursor = null;
  const salesMap = {};
  let hasMore = true;
  while (hasMore) {
    const ordRes = await admin.graphql(`
      query($cursor: String, $since: String!) {
        orders(first: 50, after: $cursor, query: $since) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              lineItems(first: 50) {
                edges {
                  node {
                    variant { id title sku product { title vendor } }
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    `, { variables: { cursor, since: `created_at:>${sinceStr}` } });
    const ordJson = await ordRes.json();
    const ordData = ordJson.data?.orders;
    hasMore = ordData?.pageInfo?.hasNextPage ?? false;
    cursor = ordData?.pageInfo?.endCursor ?? null;
    for (const o of ordData?.edges ?? []) {
      for (const li of o.node.lineItems.edges) {
        const n = li.node;
        const vid = n.variant?.id;
        const vendor = n.variant?.product?.vendor ?? "";
        if (!vid || !vendorNames.has(vendor)) continue;
        salesMap[vid] = salesMap[vid] ?? {
          qty: 0,
          productTitle: n.variant?.product?.title ?? "",
          variantTitle: n.variant?.title ?? "",
          vendor,
          sku: n.variant?.sku ?? "",
        };
        salesMap[vid].qty += n.quantity;
      }
    }
  }
  const items = [];
  for (const [variantId, data] of Object.entries(salesMap)) {
    if (data.qty === 0) continue;
    const skuRec = bestSkuRec(supplierSkus, variantId);
    items.push({
      variantId,
      productTitle: data.productTitle,
      variantTitle: data.variantTitle,
      vendor: data.vendor,
      sku: data.sku,
      supplierCode: skuRec?.supplierCode ?? "",
      qtyOrdered: data.qty,
      casePackSize: 1,
      qtyCost: skuRec?.cost ?? 0,
    });
  }
  return items;
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const purchaseOrders = await db.purchaseOrder.findMany({
    where: { shop },
    include: { items: true, supplier: true },
    orderBy: { createdAt: "desc" },
  });
  const suppliers = await db.supplier.findMany({
    where: { shop },
    orderBy: { name: "asc" },
  });
  const vendorSuppliers = await db.vendorSupplier.findMany({
    where: { shop, isPrimary: true },
  });
  const primaryVendorMap = {};
  for (const vs of vendorSuppliers) {
    if (!primaryVendorMap[vs.supplierId]) primaryVendorMap[vs.supplierId] = [];
    primaryVendorMap[vs.supplierId].push(vs.vendorName);
  }
  const locRes = await admin.graphql(`
    query { locations(first: 10) { edges { node { id name } } } }
  `);
  const locJson = await locRes.json();
  const locations = locJson.data.locations.edges.map((e) => e.node);
  return { purchaseOrders, suppliers, locations, shop, primaryVendorMap };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const supplierId = form.get("supplierId");
    const notes = form.get("notes") || "";
    const mode = form.get("mode");
    const locationId = form.get("locationId") || "";
    const poNumber = poNumberGen();
    let items = [];
    if (mode === "minmax") items = await buildMinmaxItems(admin, db, shop, supplierId, locationId);
    if (mode === "sales") items = await buildSalesItems(admin, db, shop, supplierId);
    if (mode === "manual") {
      try { items = JSON.parse(form.get("items") || "[]"); } catch { items = []; }
    }
    const po = await db.purchaseOrder.create({
      data: {
        shop, poNumber, supplierId, status: "draft",
        mode, locationId, notes,
        items: {
          create: items.map((i) => ({
            variantId: i.variantId,
            productTitle: i.productTitle,
            variantTitle: i.variantTitle,
            vendor: i.vendor ?? "",
            sku: i.sku,
            supplierCode: i.supplierCode ?? "",
            qtyOrdered: Number(i.qtyOrdered),
            casePackSize: Number(i.casePackSize ?? 1),
            qtyCost: Number(i.qtyCost),
            updatedAt: new Date(),
          })),
        },
        updatedAt: new Date(),
      },
    });
    return { ok: true, poId: po.id };
  }

  if (intent === "regenerate") {
    const id = form.get("id");
    const po = await db.purchaseOrder.findUnique({ where: { id } });
    if (!po) return { ok: false };
    let items = [];
    if (po.mode === "minmax") items = await buildMinmaxItems(admin, db, shop, po.supplierId, po.locationId);
    if (po.mode === "sales") items = await buildSalesItems(admin, db, shop, po.supplierId);
    await db.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
    await db.purchaseOrder.update({
      where: { id },
      data: {
        updatedAt: new Date(),
        items: {
          create: items.map((i) => ({
            variantId: i.variantId,
            productTitle: i.productTitle,
            variantTitle: i.variantTitle,
            vendor: i.vendor ?? "",
            sku: i.sku,
            supplierCode: i.supplierCode ?? "",
            qtyOrdered: Number(i.qtyOrdered),
            casePackSize: Number(i.casePackSize ?? 1),
            qtyCost: Number(i.qtyCost),
            updatedAt: new Date(),
          })),
        },
      },
    });
    return { ok: true, regenerated: true };
  }

  if (intent === "searchProducts") {
    const query = form.get("query");
    const supplierId = form.get("supplierId");
    const poId = form.get("poId");

    // Eligibility for the manual "Add item" search now matches PO
    // generation: gated by vendor -> supplier mapping, not by whether a
    // SupplierSku row already exists. SupplierSku is only used below to
    // pre-fill cost/supplier code when available.
    const vendorLinks = await db.vendorSupplier.findMany({ where: { shop, supplierId } });
    const vendorNames = new Set(vendorLinks.map((v) => v.vendorName));
    if (vendorNames.size === 0) return { ok: true, intent: "searchProducts", poId, results: [] };

    const supplierSkus = await db.supplierSku.findMany({
      where: { shop, supplierId },
      select: { variantId: true, supplierCode: true, cost: true },
    });
    const supplierSkuMap = new Map();
    for (const s of supplierSkus) {
      const existing = supplierSkuMap.get(s.variantId);
      if (!existing || (!existing.supplierCode && s.supplierCode)) {
        supplierSkuMap.set(s.variantId, s);
      }
    }
    const [titleRes, skuRes] = await Promise.all([
      admin.graphql(`
        query($query: String!) {
          products(first: 10, query: $query) {
            edges {
              node {
                title vendor
                variants(first: 20) {
                  edges {
                    node { id sku title inventoryItem { id unitCost { amount } } }
                  }
                }
              }
            }
          }
        }
      `, { variables: { query: `title:*${query}*` } }),
      admin.graphql(`
        query($query: String!) {
          productVariants(first: 10, query: $query) {
            edges {
              node {
                id sku title
                product { title vendor }
                inventoryItem { id unitCost { amount } }
              }
            }
          }
        }
      `, { variables: { query: `sku:${query}*` } }),
    ]);
    const [titleJson, skuJson] = await Promise.all([titleRes.json(), skuRes.json()]);
    const seen = new Set();
    const results = [];
    for (const { node: p } of titleJson.data?.products?.edges ?? []) {
      for (const { node: v } of p.variants.edges) {
        if (seen.has(v.id) || !vendorNames.has(p.vendor)) continue;
        seen.add(v.id);
        const skuRec = supplierSkuMap.get(v.id);
        results.push({ id: v.id, sku: v.sku, productTitle: p.title, variantTitle: v.title === "Default Title" ? "" : v.title, vendor: p.vendor ?? "", supplierCode: skuRec?.supplierCode ?? "", cost: skuRec?.cost ?? parseFloat(v.inventoryItem?.unitCost?.amount ?? 0) });
      }
    }
    for (const { node: v } of skuJson.data?.productVariants?.edges ?? []) {
      const vendor = v.product?.vendor ?? "";
      if (seen.has(v.id) || !vendorNames.has(vendor)) continue;
      seen.add(v.id);
      const skuRec = supplierSkuMap.get(v.id);
      results.push({ id: v.id, sku: v.sku, productTitle: v.product?.title ?? "", variantTitle: v.title === "Default Title" ? "" : v.title, vendor, supplierCode: skuRec?.supplierCode ?? "", cost: skuRec?.cost ?? parseFloat(v.inventoryItem?.unitCost?.amount ?? 0) });
    }
    return { ok: true, intent: "searchProducts", poId, results: results.slice(0, 10) };
  }

  if (intent === "addItem") {
    const purchaseOrderId = form.get("purchaseOrderId");
    await db.purchaseOrderItem.create({
      data: {
        purchaseOrderId,
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
    return { ok: true, intent: "addItem", purchaseOrderId };
  }

  if (intent === "fetchInventory") {
    const locationId = form.get("locationId");
    const variantIds = JSON.parse(form.get("variantIds") || "[]");
    const poId = form.get("poId");
    if (!locationId || variantIds.length === 0) return { ok: true, intent: "fetchInventory", poId, onHand: {}, inventoryItemIds: {} };
    const variantIdSet = new Set(variantIds);
    const onHand = {};
    const inventoryItemIds = {};
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const invRes = await admin.graphql(`
        query($locationId: ID!, $cursor: String) {
          location(id: $locationId) {
            inventoryLevels(first: 250, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  quantities(names: ["available"]) { quantity }
                  item { id variant { id } }
                }
              }
            }
          }
        }
      `, { variables: { locationId, cursor } });
      const invJson = await invRes.json();
      const levels = invJson.data?.location?.inventoryLevels;
      hasMore = levels?.pageInfo?.hasNextPage ?? false;
      cursor = levels?.pageInfo?.endCursor ?? null;
      for (const e of levels?.edges ?? []) {
        const vid = e.node?.item?.variant?.id;
        const iid = e.node?.item?.id;
        if (vid && variantIdSet.has(vid)) {
          onHand[vid] = e.node.quantities?.[0]?.quantity ?? 0;
          inventoryItemIds[vid] = iid;
        }
      }
      if (Object.keys(onHand).length === variantIds.length) break;
    }
    return { ok: true, intent: "fetchInventory", poId, onHand, inventoryItemIds };
  }

  if (intent === "adjustStock") {
    const variantId = form.get("variantId");
    const inventoryItemId = form.get("inventoryItemId");
    const locationId = form.get("locationId");
    const newQty = Number(form.get("newQty"));
    const poId = form.get("poId");
    if (!inventoryItemId || !locationId) return { ok: false, intent: "adjustStock", error: "Missing inventory item or location" };
    const res = await admin.graphql(`
      mutation($input: InventorySetOnHandQuantitiesInput!) {
        inventorySetOnHandQuantities(input: $input) {
          userErrors { field message }
          inventoryAdjustmentGroup { id }
        }
      }
    `, { variables: { input: { reason: "correction", setQuantities: [{ inventoryItemId, locationId, quantity: newQty }] } } });
    const json = await res.json();
    const errors = json.data?.inventorySetOnHandQuantities?.userErrors ?? [];
    if (errors.length > 0) return { ok: false, intent: "adjustStock", poId, variantId, error: errors.map(e => e.message).join(", ") };
    return { ok: true, intent: "adjustStock", poId, variantId, newQty };
  }

  if (intent === "receive") {
    try {
      const id = form.get("id");
      const receiveQtys = JSON.parse(form.get("receiveQtys"));
      const po = await db.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
      if (!po || !po.locationId) return { ok: false, intent: "receive", error: "PO not found or no location set" };
      const variantIds = po.items.map((i) => i.variantId);
      const inventoryItemMap = {};
      for (let i = 0; i < variantIds.length; i += 50) {
        const batch = variantIds.slice(i, i + 50);
        const varRes = await admin.graphql(`
          query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } } }
        `, { variables: { ids: batch } });
        const varJson = await varRes.json();
        for (const node of varJson.data?.nodes ?? []) {
          if (node?.id && node?.inventoryItem?.id) inventoryItemMap[node.id] = node.inventoryItem.id;
        }
      }
      const changes = [];
      for (const item of po.items) {
        const qty = Number(receiveQtys[item.id] ?? item.qtyOrdered);
        if (qty <= 0) continue;
        const inventoryItemId = inventoryItemMap[item.variantId];
        if (!inventoryItemId) continue;
        changes.push({ inventoryItemId, locationId: po.locationId, delta: qty });
      }
      if (changes.length === 0) return { ok: false, intent: "receive", error: "No items to receive" };
      const errors = [];
      for (let i = 0; i < changes.length; i += 100) {
        const adjRes = await admin.graphql(`
          mutation($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
              inventoryAdjustmentGroup { id }
              userErrors { field message }
            }
          }
        `, { variables: { input: { reason: "received", name: "available", changes: changes.slice(i, i + 100) } } });
        const adjJson = await adjRes.json();
        errors.push(...(adjJson.data?.inventoryAdjustQuantities?.userErrors ?? []).map((e) => e.message));
      }
      if (errors.length > 0) return { ok: false, intent: "receive", error: errors.join("; ") };
      await db.purchaseOrder.update({ where: { id }, data: { status: "received", updatedAt: new Date() } });
      return { ok: true, intent: "receive", poId: id };
    } catch (err) {
      console.error("RECEIVE ACTION CRASHED:", err);
      return { ok: false, intent: "receive", error: `Server error: ${err.message}` };
    }
  }

  if (intent === "updateStatus") {
    const id = form.get("id");
    const status = form.get("status");
    // "received" must only be set through the receive intent above, since
    // that's the path that actually adjusts Shopify inventory. Block it here
    // so a stray request (or a future UI change) can't silently skip the
    // inventory update.
    if (status === "received") {
      return { ok: false, intent: "updateStatus", error: "Use the Receive button to mark a PO received — it updates Shopify inventory at the same time." };
    }
    await db.purchaseOrder.update({ where: { id }, data: { status, updatedAt: new Date() } });
    return { ok: true };
  }

  if (intent === "updateItems") {
    const id = form.get("id");
    const updates = JSON.parse(form.get("updates"));
    const removedIds = JSON.parse(form.get("removedIds") || "[]");
    if (removedIds.length > 0) await db.purchaseOrderItem.deleteMany({ where: { id: { in: removedIds } } });
    for (const u of updates) {
      const cost = parseFloat(u.qtyCost) || 0;
      await db.purchaseOrderItem.update({
        where: { id: u.id },
        data: { qtyOrdered: Number(u.qtyOrdered), supplierCode: u.supplierCode, qtyCost: cost, updatedAt: new Date() },
      });
      if (u.supplierId) {
        await db.supplierSku.updateMany({
          where: { shop, variantId: u.variantId, supplierId: u.supplierId },
          data: { supplierCode: u.supplierCode, cost },
        });
      }
      try {
        const varRes = await admin.graphql(`
          query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }
        `, { variables: { id: u.variantId } });
        const varJson = await varRes.json();
        const inventoryItemId = varJson.data?.productVariant?.inventoryItem?.id;
        if (inventoryItemId) {
          await admin.graphql(`
            mutation($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { id unitCost { amount } }
                userErrors { field message }
              }
            }
          `, { variables: { id: inventoryItemId, input: { unitCost: { amount: cost.toString(), currencyCode: "USD" } } } });
        }
      } catch (err) { console.error("Cost sync failed:", err); }
    }
    return { ok: true, saved: true };
  }

  if (intent === "delete") {
    const id = form.get("id");
    await db.purchaseOrder.delete({ where: { id } });
    return { ok: true };
  }

  return { ok: false };
};

export default function PurchaseOrders() {
  const { purchaseOrders, suppliers, locations, primaryVendorMap } = useLoaderData();
  const fetcher = useFetcher();

  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState("minmax");
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [itemEdits, setItemEdits] = useState({});
  const [removedItems, setRemovedItems] = useState({});
  const [onHandData, setOnHandData] = useState({});
  const [inventoryItemIdData, setInventoryItemIdData] = useState({});
  const [receiveModal, setReceiveModal] = useState(null);
  const [receiveError, setReceiveError] = useState(null);
  const [skuSearch, setSkuSearch] = useState({});
  const [searchResults, setSearchResults] = useState({});
  const [selectedResult, setSelectedResult] = useState({});
  const [skuQty, setSkuQty] = useState({});
  const [skuCost, setSkuCost] = useState({});
  const [stockAdjust, setStockAdjust] = useState({});
  const [showReceived, setShowReceived] = useState(false);
  const [statusError, setStatusError] = useState(null);

  const debounceTimers = useRef({});
  const isSubmitting = fetcher.state !== "idle";
  const fetcherData = fetcher.data;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcherData) return;

    if (fetcherData.intent === "fetchInventory" && fetcherData.poId && onHandData[fetcherData.poId] === "loading") {
      setOnHandData((prev) => ({ ...prev, [fetcherData.poId]: fetcherData.onHand }));
      setInventoryItemIdData((prev) => ({ ...prev, [fetcherData.poId]: fetcherData.inventoryItemIds ?? {} }));
    }

    if (fetcherData.intent === "receive") {
      if (fetcherData.ok && receiveModal) {
        setReceiveModal(null);
        setReceiveError(null);
      } else if (!fetcherData.ok && fetcherData.error) {
        setReceiveError(fetcherData.error);
      }
    }

    if (fetcherData.intent === "updateStatus" && !fetcherData.ok && fetcherData.error) {
      setStatusError(fetcherData.error);
      setTimeout(() => setStatusError(null), 5000);
    }

    if (fetcherData.intent === "searchProducts" && fetcherData.poId) {
      const poId = fetcherData.poId;
      if (!searchResults[poId] || JSON.stringify(searchResults[poId]) !== JSON.stringify(fetcherData.results)) {
        setSearchResults((prev) => ({ ...prev, [poId]: fetcherData.results ?? [] }));
      }
    }

    if (fetcherData.intent === "adjustStock" && fetcherData.ok && fetcherData.variantId) {
      const vid = fetcherData.variantId;
      const poId = fetcherData.poId;
      if (stockAdjust[vid]?.saving) {
        setStockAdjust((prev) => ({ ...prev, [vid]: { open: false, value: "", saving: false, saved: true, error: null } }));
        setOnHandData((prev) => ({ ...prev, [poId]: { ...(prev[poId] ?? {}), [vid]: fetcherData.newQty } }));
        setTimeout(() => setStockAdjust((prev) => ({ ...prev, [vid]: { ...prev[vid], saved: false } })), 2000);
      }
    }

    if (fetcherData.intent === "adjustStock" && !fetcherData.ok && fetcherData.variantId) {
      const vid = fetcherData.variantId;
      if (stockAdjust[vid]?.saving) {
        setStockAdjust((prev) => ({ ...prev, [vid]: { ...prev[vid], saving: false, error: fetcherData.error } }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcherData]);

  function handleSearchChange(poId, supplierId, val) {
    setSkuSearch((prev) => ({ ...prev, [poId]: val }));
    setSearchResults((prev) => ({ ...prev, [poId]: [] }));
    setSelectedResult((prev) => ({ ...prev, [poId]: null }));
    if (debounceTimers.current[poId]) clearTimeout(debounceTimers.current[poId]);
    if (!val.trim() || val.trim().length < 2) return;
    debounceTimers.current[poId] = setTimeout(() => {
      const fd = new FormData();
      fd.append("intent", "searchProducts");
      fd.append("query", val.trim());
      fd.append("supplierId", supplierId);
      fd.append("poId", poId);
      fetcher.submit(fd, { method: "post" });
    }, 400);
  }

  function handleSelectResult(poId, result) {
    setSelectedResult((prev) => ({ ...prev, [poId]: result }));
    setSearchResults((prev) => ({ ...prev, [poId]: [] }));
    setSkuSearch((prev) => ({ ...prev, [poId]: `${result.productTitle}${result.variantTitle ? ` - ${result.variantTitle}` : ""}` }));
    setSkuQty((prev) => ({ ...prev, [poId]: "1" }));
    setSkuCost((prev) => ({ ...prev, [poId]: String(result.cost) }));
  }

  function handleCreate() {
    const fd = new FormData();
    fd.append("intent", "create");
    fd.append("supplierId", supplierId);
    fd.append("locationId", locationId);
    fd.append("mode", mode);
    fd.append("notes", notes);
    fetcher.submit(fd, { method: "post" });
    setShowCreate(false);
    setNotes("");
  }

  function handleLoadInventory(po) {
    const variantIds = po.items.map((i) => i.variantId);
    if (!po.locationId || variantIds.length === 0) return;
    setOnHandData((prev) => ({ ...prev, [po.id]: "loading" }));
    const fd = new FormData();
    fd.append("intent", "fetchInventory");
    fd.append("locationId", po.locationId);
    fd.append("variantIds", JSON.stringify(variantIds));
    fd.append("poId", po.id);
    fetcher.submit(fd, { method: "post" });
  }

  function handleRegenerate(id) {
    if (!confirm("Regenerate this PO? Current line items will be replaced with fresh inventory data.")) return;
    const fd = new FormData();
    fd.append("intent", "regenerate");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
    setItemEdits((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setRemovedItems((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setOnHandData((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  function handleStatusChange(id, status) {
    const fd = new FormData();
    fd.append("intent", "updateStatus");
    fd.append("id", id);
    fd.append("status", status);
    fetcher.submit(fd, { method: "post" });
  }

  function handleItemEdit(poId, itemId, field, val) {
    setItemEdits((prev) => ({ ...prev, [poId]: { ...prev[poId], [itemId]: { ...prev[poId]?.[itemId], [field]: val } } }));
  }

  function handleRemoveItem(poId, itemId) {
    setRemovedItems((prev) => ({ ...prev, [poId]: new Set([...(prev[poId] ?? []), itemId]) }));
    setItemEdits((prev) => { const poEdits = { ...prev[poId] }; delete poEdits[itemId]; return { ...prev, [poId]: poEdits }; });
  }

  function handleRemoveVendor(poId, itemIds) {
    setRemovedItems((prev) => ({ ...prev, [poId]: new Set([...(prev[poId] ?? []), ...itemIds]) }));
    setItemEdits((prev) => { const poEdits = { ...prev[poId] }; for (const id of itemIds) delete poEdits[id]; return { ...prev, [poId]: poEdits }; });
  }

  function handleRestoreItem(poId, itemId) {
    setRemovedItems((prev) => { const s = new Set(prev[poId] ?? []); s.delete(itemId); return { ...prev, [poId]: s }; });
  }

  function handleSaveItems(po) {
    const edits = itemEdits[po.id] ?? {};
    const removed = removedItems[po.id] ?? new Set();
    if (Object.keys(edits).length === 0 && removed.size === 0) return;
    const updates = po.items.filter((i) => !removed.has(i.id) && edits[i.id]).map((i) => ({
      id: i.id, variantId: i.variantId, supplierId: po.supplierId,
      qtyOrdered: edits[i.id]?.qtyOrdered !== undefined ? edits[i.id].qtyOrdered : i.qtyOrdered,
      supplierCode: edits[i.id]?.supplierCode !== undefined ? edits[i.id].supplierCode : (i.supplierCode ?? ""),
      qtyCost: edits[i.id]?.qtyCost !== undefined ? edits[i.id].qtyCost : i.qtyCost,
    }));
    const fd = new FormData();
    fd.append("intent", "updateItems");
    fd.append("id", po.id);
    fd.append("updates", JSON.stringify(updates));
    fd.append("removedIds", JSON.stringify([...removed]));
    fetcher.submit(fd, { method: "post" });
    setItemEdits((prev) => { const n = { ...prev }; delete n[po.id]; return n; });
    setRemovedItems((prev) => { const n = { ...prev }; delete n[po.id]; return n; });
  }

  function handleOpenReceive(po) {
    const activeItems = po.items.filter((i) => !(removedItems[po.id] ?? new Set()).has(i.id));
    const receiveQtys = Object.fromEntries(activeItems.map((i) => {
      const editedQty = itemEdits[po.id]?.[i.id]?.qtyOrdered;
      return [i.id, editedQty !== undefined ? String(editedQty) : String(i.qtyOrdered)];
    }));
    setReceiveError(null);
    setReceiveModal({ po, receiveQtys });
  }

  function handleReceiveQtyChange(itemId, val) {
    setReceiveModal((prev) => ({ ...prev, receiveQtys: { ...prev.receiveQtys, [itemId]: val } }));
  }

  function handleConfirmReceive() {
    const { po, receiveQtys } = receiveModal;
    const fd = new FormData();
    fd.append("intent", "receive");
    fd.append("id", po.id);
    fd.append("receiveQtys", JSON.stringify(receiveQtys));
    fetcher.submit(fd, { method: "post" });
  }

  function handleDelete(id) {
    if (!confirm("Delete this purchase order?")) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  function handleAddItem(po) {
    const result = selectedResult[po.id];
    if (!result) return;
    const fd = new FormData();
    fd.append("intent", "addItem");
    fd.append("purchaseOrderId", po.id);
    fd.append("variantId", result.id);
    fd.append("productTitle", result.productTitle);
    fd.append("variantTitle", result.variantTitle);
    fd.append("vendor", result.vendor ?? "");
    fd.append("sku", result.sku);
    fd.append("supplierCode", result.supplierCode);
    fd.append("qtyOrdered", skuQty[po.id] ?? "1");
    fd.append("casePackSize", "1");
    fd.append("qtyCost", skuCost[po.id] ?? "0");
    fetcher.submit(fd, { method: "post" });
    setSkuSearch((prev) => ({ ...prev, [po.id]: "" }));
    setSearchResults((prev) => ({ ...prev, [po.id]: [] }));
    setSelectedResult((prev) => ({ ...prev, [po.id]: null }));
    setSkuQty((prev) => ({ ...prev, [po.id]: "" }));
    setSkuCost((prev) => ({ ...prev, [po.id]: "" }));
  }

  function handleOpenStockAdjust(variantId, currentQty) {
    setStockAdjust((prev) => ({ ...prev, [variantId]: { open: true, value: String(currentQty ?? ""), saving: false, saved: false, error: null } }));
  }

  function handleCancelStockAdjust(variantId) {
    setStockAdjust((prev) => ({ ...prev, [variantId]: { open: false, value: "", saving: false, saved: false, error: null } }));
  }

  function handleConfirmStockAdjust(variantId, inventoryItemId, locationId, poId) {
    const newQty = Number(stockAdjust[variantId]?.value);
    if (isNaN(newQty) || newQty < 0) return;
    setStockAdjust((prev) => ({ ...prev, [variantId]: { ...prev[variantId], saving: true, error: null } }));
    const fd = new FormData();
    fd.append("intent", "adjustStock");
    fd.append("variantId", variantId);
    fd.append("inventoryItemId", inventoryItemId);
    fd.append("locationId", locationId);
    fd.append("newQty", String(newQty));
    fd.append("poId", poId);
    fetcher.submit(fd, { method: "post" });
  }

  const supplierOptions = suppliers.map((s) => ({ label: s.name, value: s.id }));
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));
  const locationNameMap = Object.fromEntries(locations.map((l) => [l.id, l.name]));

  const modeOptions = [
    { label: "Reorder from Min/Max (bring to max levels)", value: "minmax" },
    { label: "Reorder from 30-day sales velocity", value: "sales" },
    { label: "Manual — I'll enter quantities", value: "manual" },
  ];

  // "Received" is deliberately excluded from the manually-selectable status
  // options. It can only be reached via the Receive button (which also runs
  // the Shopify inventory delta adjustment), never by picking it from this
  // dropdown — see the server-side guard in the updateStatus action too.
  const manualStatusOptions = [
    { label: "Draft", value: "draft" },
    { label: "Ordered", value: "ordered" },
    { label: "Cancelled", value: "cancelled" },
  ];

  const activePOs = purchaseOrders.filter((po) => po.status !== "received" && po.status !== "cancelled");
  const completedPOs = purchaseOrders.filter((po) => po.status === "received" || po.status === "cancelled");

  function renderItemRow(item, po, poEdits, hasOnHand, poOnHand, poInventoryItemIds) {
    const qty = poEdits[item.id]?.qtyOrdered !== undefined ? poEdits[item.id].qtyOrdered : String(item.qtyOrdered);
    const supplierCode = poEdits[item.id]?.supplierCode !== undefined ? poEdits[item.id].supplierCode : (item.supplierCode ?? "");
    const cost = poEdits[item.id]?.qtyCost !== undefined ? poEdits[item.id].qtyCost : String(item.qtyCost);
    const lineTotal = (Number(qty) * Number(cost)).toFixed(2);
    const onHandQty = hasOnHand ? (poOnHand[item.variantId] ?? 0) : null;
    const inventoryItemId = poInventoryItemIds?.[item.variantId];
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
            <Button variant="plain" onClick={() => handleRestoreItem(po.id, item.id)}>Restore</Button>
          </td>
        </tr>
      );
    }

    return (
      <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
        <td style={{ padding: "8px 12px", width: "180px" }}>
          <TextField label="" labelHidden value={supplierCode} onChange={(val) => handleItemEdit(po.id, item.id, "supplierCode", val)} autoComplete="off" placeholder="—" />
        </td>
        <td style={{ padding: "8px 12px" }}><Text>{item.productTitle}</Text></td>
        <td style={{ padding: "8px 12px" }}><Text tone="subdued">{item.sku}</Text></td>
        {hasOnHand && (
          <td style={{ padding: "8px 12px", width: "140px" }}>
            {adjust?.open ? (
              <InlineStack gap="100" blockAlign="center">
                <div style={{ width: "90px" }}>
                  <TextField label="" labelHidden type="number" value={adjust.value} onChange={(val) => setStockAdjust((prev) => ({ ...prev, [item.variantId]: { ...prev[item.variantId], value: val } }))} autoComplete="off" min="0" />
                </div>
                <Button size="slim" variant="primary" onClick={() => handleConfirmStockAdjust(item.variantId, inventoryItemId, po.locationId, po.id)} loading={adjust.saving} disabled={adjust.saving}>✓</Button>
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
        <td style={{ padding: "8px 12px", width: "140px" }}>
          <TextField label="" labelHidden type="number" value={qty} onChange={(val) => handleItemEdit(po.id, item.id, "qtyOrdered", val)} autoComplete="off" />
        </td>
        <td style={{ padding: "8px 12px", width: "70px", textAlign: "center" }}>
          {casesOrdered !== null ? <Text tone="subdued">{casesOrdered}</Text> : <Text tone="subdued">—</Text>}
        </td>
        <td style={{ padding: "8px 12px", width: "200px" }}>
          <TextField label="" labelHidden type="number" prefix="$" value={cost} onChange={(val) => handleItemEdit(po.id, item.id, "qtyCost", val)} autoComplete="off" />
        </td>
        <td style={{ padding: "8px 12px" }}><Text>${lineTotal}</Text></td>
        <td style={{ padding: "8px 12px" }}>
          <Button variant="plain" tone="critical" onClick={() => handleRemoveItem(po.id, item.id)}>Remove</Button>
        </td>
      </tr>
    );
  }

  function renderPOCard(po) {
    const isExpanded = expandedId === po.id;
    const poEdits = itemEdits[po.id] ?? {};
    const poRemoved = removedItems[po.id] ?? new Set();
    const hasChanges = Object.keys(poEdits).length > 0 || poRemoved.size > 0;
    const poOnHand = onHandData[po.id];
    const poInventoryItemIds = inventoryItemIdData[po.id] ?? {};
    const isLoadingInventory = poOnHand === "loading";
    const hasOnHand = poOnHand && poOnHand !== "loading";
    const locationLabel = po.locationId ? (locationNameMap[po.locationId] ?? "") : null;
    const canReceive = po.status !== "received" && po.status !== "cancelled" && po.items.length > 0 && po.locationId;
    const primaryVendors = new Set(primaryVendorMap[po.supplierId] ?? []);

    const displayItems = po.items.map((i) => ({
      ...i,
      qtyOrdered: poEdits[i.id]?.qtyOrdered !== undefined ? Number(poEdits[i.id].qtyOrdered) : i.qtyOrdered,
      supplierCode: poEdits[i.id]?.supplierCode !== undefined ? poEdits[i.id].supplierCode : (i.supplierCode ?? ""),
      qtyCost: poEdits[i.id]?.qtyCost !== undefined ? Number(poEdits[i.id].qtyCost) : i.qtyCost,
      removed: poRemoved.has(i.id),
    }));

    const activeItems = displayItems.filter((i) => !i.removed);
    const totalCost = activeItems.reduce((s, i) => s + i.qtyOrdered * i.qtyCost, 0);
    const totalUnits = activeItems.reduce((s, i) => s + i.qtyOrdered, 0);

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
    const poSearchResults = searchResults[po.id] ?? [];
    const poSelected = selectedResult[po.id];
    const isSearching = isSubmitting && fetcher.formData?.get("intent") === "searchProducts" && fetcher.formData?.get("poId") === po.id;
    const isDuplicate = poSelected && po.items.some((i) => i.variantId === poSelected.id && !poRemoved.has(i.id));

    function renderVendorGroup(vendor, items, isSecondary) {
      const activeGroupIds = items.filter((i) => !i.removed).map((i) => i.id);
      const activeCount = activeGroupIds.length;
      return (
        <BlockStack key={vendor} gap="100">
          <div style={{ background: isSecondary ? "#fff8f0" : "#f6f6f7", padding: "6px 12px", borderRadius: "6px" }}>
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="headingSm">{vendor}</Text>
                {isSecondary && <Badge tone="warning">Not primary</Badge>}
                <Text tone="subdued" variant="bodySm">{activeCount} SKU{activeCount !== 1 ? "s" : ""}</Text>
              </InlineStack>
              {activeCount > 0 && (
                <Button variant="plain" tone="critical" onClick={() => handleRemoveVendor(po.id, activeGroupIds)}>Remove all</Button>
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
            <tbody>{items.map((item) => renderItemRow(item, po, poEdits, hasOnHand, poOnHand, poInventoryItemIds))}</tbody>
          </table>
        </BlockStack>
      );
    }

    return (
      <div key={po.id} style={{ marginBottom: "1rem" }}>
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingMd">{po.poNumber}</Text>
                  {statusBadge(po.status)}
                  <Badge tone="default">{po.mode}</Badge>
                  {locationLabel && locationBadge(locationLabel)}
                </InlineStack>
                <Text tone="subdued">
                  {po.supplier?.name} · {activeItems.length} SKUs · {totalUnits} units · ${totalCost.toFixed(2)}
                </Text>
                <Text tone="subdued" variant="bodySm">
                  Created {new Date(po.createdAt).toLocaleDateString("en-US")}
                  {po.notes ? ` · ${po.notes}` : ""}
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                {po.status === "received" ? (
                  statusBadge(po.status)
                ) : (
                  <Select label="" labelHidden options={manualStatusOptions} value={po.status} onChange={(val) => handleStatusChange(po.id, val)} />
                )}
                {canReceive && <Button variant="primary" onClick={() => handleOpenReceive(po)}>✓ Receive</Button>}
                {po.mode !== "manual" && <Button variant="plain" onClick={() => handleRegenerate(po.id)}>↺ Regenerate</Button>}
                <Button variant="plain" onClick={() => downloadCSV({ ...po, items: activeItems }, hasOnHand ? poOnHand : null)}>↓ CSV</Button>
                <Button variant="plain" onClick={() => setExpandedId(isExpanded ? null : po.id)}>
                  {isExpanded ? "Hide items" : "View items"}
                </Button>
                <Button variant="plain" tone="critical" onClick={() => handleDelete(po.id)}>Delete</Button>
              </InlineStack>
            </InlineStack>

            {isExpanded && (
              <>
                <Divider />
                {po.items.length === 0 ? (
                  <Banner tone="info">No items needed — all SKUs for this supplier are at or above their minimum levels.</Banner>
                ) : (
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text tone="subdued" variant="bodySm">
                        {hasOnHand ? `Live on-hand at ${locationLabel ?? "selected location"} — click Adjust next to any item to correct the count` : po.locationId ? `On-hand not loaded yet — click to fetch live from Shopify` : "No location set on this PO"}
                      </Text>
                      {po.locationId && (
                        <Button variant="plain" onClick={() => handleLoadInventory(po)} loading={isLoadingInventory} disabled={isLoadingInventory}>
                          {hasOnHand ? "↺ Refresh on-hand" : "Load on-hand qty"}
                        </Button>
                      )}
                    </InlineStack>

                    {Object.entries(primaryGroups).sort(([a], [b]) => a.localeCompare(b)).map(([vendor, items]) => renderVendorGroup(vendor, items, false))}

                    {Object.keys(secondaryGroups).length > 0 && (
                      <BlockStack gap="300">
                        <div style={{ padding: "8px 12px", background: "#fff4e5", borderRadius: "6px" }}>
                          <Text variant="headingSm" tone="subdued">Backup / Secondary source</Text>
                        </div>
                        {Object.entries(secondaryGroups).sort(([a], [b]) => a.localeCompare(b)).map(([vendor, items]) => renderVendorGroup(vendor, items, true))}
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
                        <Button variant="primary" onClick={() => handleSaveItems(po)}>Save changes</Button>
                      </InlineStack>
                    )}

                    <Divider />
                    <Text variant="headingSm">Add item</Text>
                    <TextField
                      label="Search by product name or SKU" labelHidden
                      value={skuSearch[po.id] ?? ""}
                      onChange={(val) => handleSearchChange(po.id, po.supplierId, val)}
                      autoComplete="off"
                      placeholder="Type product name or SKU..."
                      suffix={isSearching ? <Spinner size="small" /> : undefined}
                    />

                    {poSearchResults.length > 0 && (
                      <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: "4px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)", maxHeight: "300px", overflowY: "auto", marginTop: "4px" }}>
                        {poSearchResults.map((result) => {
                          const alreadyOnPO = po.items.some((i) => i.variantId === result.id && !poRemoved.has(i.id));
                          return (
                            <div key={result.id} onClick={() => handleSelectResult(po.id, result)}
                              style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #f1f2f3", background: alreadyOnPO ? "#fff4e5" : "#fff" }}
                              onMouseEnter={(e) => e.currentTarget.style.background = alreadyOnPO ? "#ffe8cc" : "#fff"}
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

                    {poSelected && (
                      <Card>
                        <BlockStack gap="300">
                          {isDuplicate && <Banner tone="warning">This SKU is already on this PO. Adding it again will create a duplicate line item.</Banner>}
                          <BlockStack gap="100">
                            <Text fontWeight="semibold">{poSelected.productTitle}{poSelected.variantTitle ? ` — ${poSelected.variantTitle}` : ""}</Text>
                            <Text tone="subdued">SKU: {poSelected.sku}{poSelected.supplierCode ? ` · Code: ${poSelected.supplierCode}` : ""}</Text>
                          </BlockStack>
                          <InlineStack gap="300" blockAlign="end">
                            <div style={{ width: "100px" }}>
                              <TextField label="Qty (eaches)" type="number" value={skuQty[po.id] ?? "1"} onChange={(val) => setSkuQty((prev) => ({ ...prev, [po.id]: val }))} autoComplete="off" min="1" />
                            </div>
                            <div style={{ width: "120px" }}>
                              <TextField label="Unit cost" type="number" prefix="$" value={skuCost[po.id] ?? "0"} onChange={(val) => setSkuCost((prev) => ({ ...prev, [po.id]: val }))} autoComplete="off" />
                            </div>
                            <Button variant="primary" onClick={() => handleAddItem(po)} loading={isSubmitting && fetcher.formData?.get("intent") === "addItem"}>Add to PO</Button>
                          </InlineStack>
                        </BlockStack>
                      </Card>
                    )}
                  </BlockStack>
                )}
              </>
            )}
          </BlockStack>
        </Card>
      </div>
    );
  }

  return (
    <Page
      title="Purchase Orders"
      primaryAction={<Button variant="primary" onClick={() => setShowCreate(true)}>+ New PO</Button>}
    >
      <Layout>
        <Layout.Section>

          {statusError && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner tone="critical" onDismiss={() => setStatusError(null)}>{statusError}</Banner>
            </div>
          )}

          <Modal
            open={showCreate}
            onClose={() => setShowCreate(false)}
            title="Create Purchase Order"
            primaryAction={{ content: "Generate PO", onAction: handleCreate, disabled: !supplierId }}
            secondaryActions={[{ content: "Cancel", onAction: () => setShowCreate(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="400">
                {suppliers.length === 0 && <Banner tone="warning">No suppliers set up yet. Add suppliers first.</Banner>}
                <Select label="Supplier" options={supplierOptions} value={supplierId} onChange={setSupplierId} />
                <Select label="How to populate items" options={modeOptions} value={mode} onChange={setMode} />
                {(mode === "minmax" || mode === "sales") && (
                  <Select label="Location" options={locationOptions} value={locationId} onChange={setLocationId}
                    helpText={mode === "minmax" ? "Check inventory at this location against min/max targets" : "Sales are store-wide; inventory will be delivered here"} />
                )}
                {mode === "manual" && <Banner tone="info">A blank PO will be created. You can add line items after saving.</Banner>}
                <TextField label="Notes (optional)" value={notes} onChange={setNotes} multiline={2} placeholder="Promo code, delivery instructions, etc." />
              </BlockStack>
            </Modal.Section>
          </Modal>

          {receiveModal && (
            <Modal
              open
              onClose={() => { setReceiveModal(null); setReceiveError(null); }}
              title={`Receive ${receiveModal.po.poNumber}`}
              primaryAction={{ content: "Receive & Update Shopify Inventory", onAction: handleConfirmReceive, loading: isSubmitting, disabled: isSubmitting }}
              secondaryActions={[{ content: "Cancel", onAction: () => { setReceiveModal(null); setReceiveError(null); } }]}
            >
              <Modal.Section>
                <BlockStack gap="400">
                  <Text>Receiving at: <strong>{locationNameMap[receiveModal.po.locationId] ?? receiveModal.po.locationId}</strong></Text>
                  <Text tone="subdued">Adjust quantities below if you received a partial shipment.</Text>
                  {receiveError && <Banner tone="critical">{receiveError}</Banner>}
                  {fetcherData?.intent === "receive" && (
                    <Banner tone="info">
                      <pre style={{ whiteSpace: "pre-wrap", fontSize: "11px" }}>{JSON.stringify(fetcherData, null, 2)}</pre>
                    </Banner>
                  )}
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
                        {receiveModal.po.items.filter((i) => !(removedItems[receiveModal.po.id] ?? new Set()).has(i.id)).map((item) => (
                          <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                            <td style={{ padding: "8px 12px" }}><Text>{item.productTitle}</Text></td>
                            <td style={{ padding: "8px 12px" }}><Text>{item.sku}</Text></td>
                            <td style={{ padding: "8px 12px", width: "110px" }}>
                              <TextField label="" labelHidden type="number" value={receiveModal.receiveQtys[item.id] ?? String(item.qtyOrdered)} onChange={(val) => handleReceiveQtyChange(item.id, val)} autoComplete="off" min="0" />
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

          {isSubmitting && !receiveModal && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <Text>Working on it — this may take a moment for large catalogs…</Text>
            </div>
          )}

          {!isSubmitting && purchaseOrders.length === 0 && (
            <Card>
              <EmptyState heading="No purchase orders yet" image="">
                <p>Create a PO to track incoming inventory from your suppliers.</p>
              </EmptyState>
            </Card>
          )}

          {/* Active POs */}
          {activePOs.map((po) => renderPOCard(po))}

          {/* Received / Cancelled section */}
          {completedPOs.length > 0 && (
            <div style={{ marginTop: "2rem" }}>
              <div
                onClick={() => setShowReceived((v) => !v)}
                style={{ cursor: "pointer", userSelect: "none", marginBottom: "1rem" }}
              >
                <InlineStack gap="300" blockAlign="center">
                  <div style={{ height: "1px", background: "#e1e3e5", flex: 1 }} />
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="headingSm" tone="subdued">
                      Received & Cancelled
                    </Text>
                    <Badge tone="subdued">{completedPOs.length}</Badge>
                    <Text tone="subdued" variant="bodySm">{showReceived ? "▲ hide" : "▼ show"}</Text>
                  </InlineStack>
                  <div style={{ height: "1px", background: "#e1e3e5", flex: 1 }} />
                </InlineStack>
              </div>
              {showReceived && completedPOs.map((po) => renderPOCard(po))}
            </div>
          )}

        </Layout.Section>
      </Layout>
    </Page>
  );
}