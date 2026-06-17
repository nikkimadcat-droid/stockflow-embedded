import { useState, useRef } from "react";
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
  Checkbox,
} from "@shopify/polaris";

function transferNumberGen() {
  const d = new Date();
  return `TR-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 900) + 100}`;
}

function statusBadge(status) {
  const map = { draft: "info", sent: "warning", received: "success", cancelled: "critical" };
  return <Badge tone={map[status] ?? "info"}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}

function downloadPickListCSV(transfer, locationName, items) {
  const rows = [
    [`Pick List — ${locationName}`],
    [`Transfer: ${transfer.transferNumber}`],
    [`Date: ${new Date().toLocaleDateString()}`],
    [],
    ["Vendor", "Product", "SKU", "Qty to Pull", "Source On Hand", "Dest On Hand", "Dest Need"],
    ...items.map(i => [i.vendor, i.productTitle, i.sku, i.qty, i.srcOnHand ?? "", i.destOnHand ?? "", i.destNeed ?? ""]),
  ];
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${transfer.transferNumber}-${locationName.replace(/\s+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function buildDistributionItems(admin, db, shop, fromLocationId, toLocationId, vendorNames) {
  const products = [];
  for (const vendor of vendorNames) {
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const res = await admin.graphql(`
        query($cursor: String, $query: String!) {
          products(first: 250, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title vendor
                variants(first: 100) {
                  edges { node { id sku } }
                }
              }
            }
          }
        }
      `, { variables: { cursor, query: `vendor:'${vendor}'` } });
      const json = await res.json();
      const page = json.data.products;
      products.push(...page.edges.map(e => e.node));
      hasMore = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }
  }

  const variantMap = {};
  for (const p of products) {
    for (const { node: v } of p.variants.edges) {
      variantMap[v.id] = { variantId: v.id, productTitle: p.title, vendor: p.vendor, sku: v.sku || "—" };
    }
  }
  const variantIds = new Set(Object.keys(variantMap));

  const destMinMax = {};
  const minmaxRows = await db.minMax.findMany({
    where: { shop, locationId: toLocationId, variantId: { in: [...variantIds] } },
  });
  for (const mm of minmaxRows) destMinMax[mm.variantId] = mm;

  const srcMinMax = {};
  const srcMinmaxRows = await db.minMax.findMany({
    where: { shop, locationId: fromLocationId, variantId: { in: [...variantIds] } },
  });
  for (const mm of srcMinmaxRows) srcMinMax[mm.variantId] = mm;

  const destInv = {};
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const res = await admin.graphql(`
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
    `, { variables: { locationId: toLocationId, cursor } });
    const json = await res.json();
    const levels = json.data?.location?.inventoryLevels;
    hasMore = levels?.pageInfo?.hasNextPage ?? false;
    cursor = levels?.pageInfo?.endCursor ?? null;
    for (const e of levels?.edges ?? []) {
      const vid = e.node.item?.variant?.id;
      if (vid && variantIds.has(vid)) destInv[vid] = e.node.quantities?.[0]?.quantity ?? 0;
    }
  }

  const srcInv = {};
  let srcCursor = null;
  let srcHasMore = true;
  while (srcHasMore) {
    const res = await admin.graphql(`
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
    `, { variables: { locationId: fromLocationId, cursor: srcCursor } });
    const json = await res.json();
    const levels = json.data?.location?.inventoryLevels;
    srcHasMore = levels?.pageInfo?.hasNextPage ?? false;
    srcCursor = levels?.pageInfo?.endCursor ?? null;
    for (const e of levels?.edges ?? []) {
      const vid = e.node.item?.variant?.id;
      if (vid && variantIds.has(vid)) srcInv[vid] = e.node.quantities?.[0]?.quantity ?? 0;
    }
  }

  const items = [];
  for (const [vid, info] of Object.entries(variantMap)) {
    const mm = destMinMax[vid];
    if (!mm) continue;
    const destOnHand = destInv[vid] ?? 0;
    if (destOnHand >= mm.minLevel) continue;
    const destNeed = mm.maxLevel - destOnHand;
    if (destNeed <= 0) continue;
    const srcOnHand = srcInv[vid] ?? 0;
    const srcMin = srcMinMax[vid]?.minLevel ?? 0;
    const available = srcOnHand - srcMin;
    if (available <= 0) continue;
    const casePack = mm.casePackSize || 1;
    const rawQty = Math.min(destNeed, available);
    const qty = casePack > 1 ? Math.min(Math.ceil(rawQty / casePack) * casePack, available) : rawQty;
    if (qty <= 0) continue;
    items.push({
      variantId: vid,
      productTitle: info.productTitle,
      variantTitle: "",
      vendor: info.vendor,
      sku: info.sku,
      qty, srcOnHand, srcMin, available, destOnHand, destNeed,
    });
  }

  items.sort((a, b) => {
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
    return a.productTitle.localeCompare(b.productTitle);
  });

  return items;
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const locRes = await admin.graphql(`
    query { locations(first: 10) { edges { node { id name } } } }
  `);
  const locJson = await locRes.json();
  const locations = locJson.data.locations.edges.map(e => e.node);

  const vendors = new Set();
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const res = await admin.graphql(`
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { vendor } }
        }
      }
    `, { variables: { cursor } });
    const json = await res.json();
    const page = json.data.products;
    for (const { node: p } of page.edges) { if (p.vendor) vendors.add(p.vendor); }
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  const templates = await db.transferTemplate.findMany({
    where: { shop },
    include: { vendors: true },
    orderBy: { name: "asc" },
  });

  const transfers = await db.transfer.findMany({
    where: { shop },
    include: { items: true, template: true },
    orderBy: { createdAt: "desc" },
  });

  return { locations, allVendors: [...vendors].sort(), templates, transfers, shop };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "createTemplate") {
    const name = form.get("name");
    const fromLocationId = form.get("fromLocationId");
    const toLocationId = form.get("toLocationId");
    const vendorList = JSON.parse(form.get("vendors") || "[]");
    await db.transferTemplate.create({
      data: {
        shop, name, type: "distribution",
        fromLocationId, toLocationId,
        updatedAt: new Date(),
        vendors: { create: vendorList.map(v => ({ vendor: v })) },
      },
    });
    return { ok: true };
  }

  if (intent === "updateTemplate") {
    const id = form.get("id");
    const vendorList = JSON.parse(form.get("vendors") || "[]");
    await db.transferTemplateVendor.deleteMany({ where: { templateId: id } });
    await db.transferTemplateVendor.createMany({
      data: vendorList.map(v => ({ id: `${id}-${v}`, templateId: id, vendor: v })),
    });
    return { ok: true };
  }

  if (intent === "deleteTemplate") {
    const id = form.get("id");
    await db.transferTemplate.delete({ where: { id } });
    return { ok: true };
  }

  if (intent === "create") {
    const templateId = form.get("templateId");
    const fromLocationId = form.get("fromLocationId");
    const toLocationId = form.get("toLocationId");
    const notes = form.get("notes") || "";
    const transferNumber = transferNumberGen();

    let items = [];
    if (templateId) {
      const template = await db.transferTemplate.findUnique({
        where: { id: templateId },
        include: { vendors: true },
      });
      const vendorNames = template?.vendors.map(v => v.vendor) ?? [];
      items = await buildDistributionItems(admin, db, shop, fromLocationId, toLocationId, vendorNames);
    }

    await db.transfer.create({
      data: {
        shop, transferNumber,
        templateId: templateId || null,
        fromLocationId, toLocationId,
        status: "draft", notes,
        items: {
          create: items.map(i => ({
            variantId: i.variantId,
            productTitle: i.productTitle,
            variantTitle: i.variantTitle || "",
            vendor: i.vendor,
            sku: i.sku,
            qty: Number(i.qty),
            srcOnHand: Number(i.srcOnHand ?? 0),
            destOnHand: Number(i.destOnHand ?? 0),
            srcMin: Number(i.srcMin ?? 0),
            destNeed: Number(i.destNeed ?? 0),
            updatedAt: new Date(),
          })),
        },
        updatedAt: new Date(),
      },
    });
    return { ok: true };
  }

  if (intent === "regenerate") {
    const id = form.get("id");
    const transfer = await db.transfer.findUnique({
      where: { id },
      include: { template: { include: { vendors: true } } },
    });
    if (!transfer) return { ok: false };
    const vendorNames = transfer.template?.vendors.map(v => v.vendor) ?? [];
    const items = await buildDistributionItems(admin, db, shop, transfer.fromLocationId, transfer.toLocationId, vendorNames);
    await db.transferItem.deleteMany({ where: { transferId: id } });
    await db.transfer.update({
      where: { id },
      data: {
        updatedAt: new Date(),
        items: {
          create: items.map(i => ({
            variantId: i.variantId,
            productTitle: i.productTitle,
            variantTitle: i.variantTitle || "",
            vendor: i.vendor,
            sku: i.sku,
            qty: Number(i.qty),
            srcOnHand: Number(i.srcOnHand ?? 0),
            destOnHand: Number(i.destOnHand ?? 0),
            srcMin: Number(i.srcMin ?? 0),
            destNeed: Number(i.destNeed ?? 0),
            updatedAt: new Date(),
          })),
        },
      },
    });
    return { ok: true, regenerated: true };
  }

  if (intent === "loadOnHand") {
    const id = form.get("id");
    const transfer = await db.transfer.findUnique({ where: { id }, include: { items: true } });
    if (!transfer) return { ok: false };

    const variantIds = [...new Set(transfer.items.map(i => i.variantId))];
    const variantIdSet = new Set(variantIds);

    const fetchInv = async (locationId) => {
      const inv = {};
      let cursor = null;
      let hasMore = true;
      while (hasMore) {
        const res = await admin.graphql(`
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
        `, { variables: { locationId, cursor } });
        const json = await res.json();
        const levels = json.data?.location?.inventoryLevels;
        hasMore = levels?.pageInfo?.hasNextPage ?? false;
        cursor = levels?.pageInfo?.endCursor ?? null;
        for (const e of levels?.edges ?? []) {
          const vid = e.node.item?.variant?.id;
          if (vid && variantIdSet.has(vid)) inv[vid] = e.node.quantities?.[0]?.quantity ?? 0;
        }
        if (Object.keys(inv).length === variantIds.length) break;
      }
      return inv;
    };

    const [srcInv, destInv] = await Promise.all([
      fetchInv(transfer.fromLocationId),
      fetchInv(transfer.toLocationId),
    ]);

    const [srcMM, destMM] = await Promise.all([
      db.minMax.findMany({ where: { shop, locationId: transfer.fromLocationId, variantId: { in: variantIds } } }),
      db.minMax.findMany({ where: { shop, locationId: transfer.toLocationId, variantId: { in: variantIds } } }),
    ]);
    const srcMinMax = Object.fromEntries(srcMM.map(m => [m.variantId, m]));
    const destMinMax = Object.fromEntries(destMM.map(m => [m.variantId, m]));

    for (const item of transfer.items) {
      const srcOnHand = srcInv[item.variantId] ?? 0;
      const destOnHand = destInv[item.variantId] ?? 0;
      const srcMin = srcMinMax[item.variantId]?.minLevel ?? 0;
      const destMax = destMinMax[item.variantId]?.maxLevel ?? 0;
      const destNeed = Math.max(0, destMax - destOnHand);
      await db.transferItem.update({
        where: { id: item.id },
        data: { srcOnHand, destOnHand, srcMin, destNeed, updatedAt: new Date() },
      });
    }

    return { ok: true, intent: "loadOnHand", transferId: id };
  }

  if (intent === "searchProducts") {
    const query = form.get("query");
    const transferId = form.get("transferId");
    const fromLocationId = form.get("fromLocationId");
    const toLocationId = form.get("toLocationId");

    const [titleRes, skuRes] = await Promise.all([
      admin.graphql(`
        query($query: String!) {
          products(first: 10, query: $query) {
            edges {
              node {
                title vendor
                variants(first: 20) {
                  edges { node { id sku title } }
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
              }
            }
          }
        }
      `, { variables: { query: `sku:${query}*` } }),
    ]);

    const [titleJson, skuJson] = await Promise.all([titleRes.json(), skuRes.json()]);

    const seen = new Set();
    const variants = [];

    for (const { node: p } of titleJson.data?.products?.edges ?? []) {
      for (const { node: v } of p.variants.edges) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        variants.push({ id: v.id, sku: v.sku, productTitle: p.title, variantTitle: v.title === "Default Title" ? "" : v.title, vendor: p.vendor });
      }
    }

    for (const { node: v } of skuJson.data?.productVariants?.edges ?? []) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      variants.push({ id: v.id, sku: v.sku, productTitle: v.product?.title ?? "", variantTitle: v.title === "Default Title" ? "" : v.title, vendor: v.product?.vendor ?? "" });
    }

    const variantIdSet = new Set(variants.map(v => v.id));

    const fetchInvForVariants = async (locationId) => {
      const inv = {};
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
                    item { variant { id } }
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
          if (vid && variantIdSet.has(vid)) inv[vid] = e.node.quantities?.[0]?.quantity ?? 0;
        }
        if (Object.keys(inv).length === variants.length) break;
      }
      return inv;
    };

    const [srcOnHandMap, destOnHandMap] = await Promise.all([
      fetchInvForVariants(fromLocationId),
      toLocationId ? fetchInvForVariants(toLocationId) : Promise.resolve({}),
    ]);

    const results = variants.slice(0, 10).map(v => ({
      ...v,
      srcOnHand: srcOnHandMap[v.id] ?? 0,
      destOnHand: destOnHandMap[v.id] ?? 0,
    }));
    return { ok: true, intent: "searchProducts", transferId, results };
  }

  if (intent === "addItem") {
    const transferId = form.get("transferId");
    const variantId = form.get("variantId");
    const productTitle = form.get("productTitle");
    const variantTitle = form.get("variantTitle");
    const vendor = form.get("vendor");
    const sku = form.get("sku");
    const qty = Number(form.get("qty")) || 1;
    const srcOnHand = Number(form.get("srcOnHand")) || 0;
    const destOnHand = Number(form.get("destOnHand")) || 0;

    await db.transferItem.create({
      data: {
        transferId, variantId,
        productTitle, variantTitle,
        vendor, sku, qty,
        srcOnHand, destOnHand,
        srcMin: 0, destNeed: 0,
        updatedAt: new Date(),
      },
    });
    return { ok: true, intent: "addItem", transferId };
  }

  if (intent === "updateItems") {
    const id = form.get("id");
    const updates = JSON.parse(form.get("updates"));
    const removedIds = JSON.parse(form.get("removedIds") || "[]");
    if (removedIds.length > 0) {
      await db.transferItem.deleteMany({ where: { id: { in: removedIds } } });
    }
    for (const u of updates) {
      await db.transferItem.update({
        where: { id: u.id },
        data: { qty: Number(u.qty), updatedAt: new Date() },
      });
    }
    return { ok: true };
  }

  if (intent === "updateStatus") {
    const id = form.get("id");
    const status = form.get("status");
    await db.transfer.update({ where: { id }, data: { status, updatedAt: new Date() } });
    return { ok: true };
  }

  if (intent === "pushToShopify") {
    const id = form.get("id");
    const transfer = await db.transfer.findUnique({ where: { id }, include: { items: true } });
    if (!transfer) return { ok: false };

    const errors = [];
    for (const item of transfer.items) {
      const res = await admin.graphql(`
        query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }
      `, { variables: { id: item.variantId } });
      const json = await res.json();
      const inventoryItemId = json.data?.productVariant?.inventoryItem?.id;
      if (!inventoryItemId) continue;

      const adjRes = await admin.graphql(`
        mutation($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            inventoryAdjustmentGroup { id }
            userErrors { field message }
          }
        }
      `, {
        variables: {
          input: {
            reason: "restock",
            name: "available",
            changes: [
              { inventoryItemId, locationId: transfer.fromLocationId, delta: -item.qty },
              { inventoryItemId, locationId: transfer.toLocationId, delta: item.qty },
            ],
          },
        },
      });
      const adjJson = await adjRes.json();
      const errs = adjJson.data?.inventoryAdjustQuantities?.userErrors ?? [];
      if (errs.length > 0) errors.push(...errs.map(e => e.message));
    }

    if (errors.length > 0) return { ok: false, errors };
    await db.transfer.update({ where: { id }, data: { status: "sent", updatedAt: new Date() } });
    return { ok: true, pushed: true };
  }

  if (intent === "delete") {
    const id = form.get("id");
    await db.transfer.delete({ where: { id } });
    return { ok: true };
  }

  return { ok: false };
};

export default function Transfers() {
  const { locations, allVendors, templates, transfers } = useLoaderData();
  const fetcher = useFetcher();

  const [showCreate, setShowCreate] = useState(false);
  const [showAdHoc, setShowAdHoc] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showEditTemplate, setShowEditTemplate] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [adHocFrom, setAdHocFrom] = useState(locations[0]?.id ?? "");
  const [adHocTo, setAdHocTo] = useState(locations[1]?.id ?? "");
  const [adHocNotes, setAdHocNotes] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [qtyEdits, setQtyEdits] = useState({});
  const [removedItems, setRemovedItems] = useState({});
  const [itemSearch, setItemSearch] = useState({});
  const [searchResults, setSearchResults] = useState({});
  const [selectedResult, setSelectedResult] = useState({});
  const [itemQty, setItemQty] = useState({});
  const [loadedOnHand, setLoadedOnHand] = useState(new Set());

  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateFrom, setNewTemplateFrom] = useState(locations[0]?.id ?? "");
  const [newTemplateTo, setNewTemplateTo] = useState(locations[1]?.id ?? "");
  const [newTemplateVendors, setNewTemplateVendors] = useState(new Set());
  const [editVendors, setEditVendors] = useState(new Set());

  const debounceTimers = useRef({});
  const isSubmitting = fetcher.state !== "idle";
  const fetcherData = fetcher.data;

  if (fetcher.state === "idle" && fetcherData?.intent === "searchProducts" && fetcherData?.transferId) {
    const tid = fetcherData.transferId;
    if (!searchResults[tid] || JSON.stringify(searchResults[tid]) !== JSON.stringify(fetcherData.results)) {
      setSearchResults(prev => ({ ...prev, [tid]: fetcherData.results ?? [] }));
    }
  }

  if (fetcher.state === "idle" && fetcherData?.intent === "loadOnHand" && fetcherData?.transferId) {
    const tid = fetcherData.transferId;
    if (!loadedOnHand.has(tid)) {
      setLoadedOnHand(prev => new Set([...prev, tid]));
    }
  }

  const selectedTemplate = templates.find(t => t.id === selectedTemplateId);

  function toggleNewVendor(v) {
    setNewTemplateVendors(prev => { const s = new Set(prev); s.has(v) ? s.delete(v) : s.add(v); return s; });
  }
  function toggleEditVendor(v) {
    setEditVendors(prev => { const s = new Set(prev); s.has(v) ? s.delete(v) : s.add(v); return s; });
  }

  function handleCreateTemplate() {
    if (!newTemplateName) return;
    const fd = new FormData();
    fd.append("intent", "createTemplate");
    fd.append("name", newTemplateName);
    fd.append("fromLocationId", newTemplateFrom);
    fd.append("toLocationId", newTemplateTo);
    fd.append("vendors", JSON.stringify([...newTemplateVendors]));
    fetcher.submit(fd, { method: "post" });
    setNewTemplateName("");
    setNewTemplateVendors(new Set());
  }

  function handleOpenEditTemplate(template) {
    setEditVendors(new Set(template.vendors.map(v => v.vendor)));
    setShowEditTemplate(template);
  }

  function handleSaveEditTemplate() {
    const fd = new FormData();
    fd.append("intent", "updateTemplate");
    fd.append("id", showEditTemplate.id);
    fd.append("vendors", JSON.stringify([...editVendors]));
    fetcher.submit(fd, { method: "post" });
    setShowEditTemplate(null);
  }

  function handleDeleteTemplate(id) {
    if (!confirm("Delete this template?")) return;
    const fd = new FormData();
    fd.append("intent", "deleteTemplate");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  function handleCreate() {
    if (!selectedTemplate) return;
    const fd = new FormData();
    fd.append("intent", "create");
    fd.append("templateId", selectedTemplateId);
    fd.append("fromLocationId", selectedTemplate.fromLocationId);
    fd.append("toLocationId", selectedTemplate.toLocationId);
    fd.append("notes", notes);
    fetcher.submit(fd, { method: "post" });
    setShowCreate(false);
    setNotes("");
  }

  function handleCreateAdHoc() {
    const fd = new FormData();
    fd.append("intent", "create");
    fd.append("fromLocationId", adHocFrom);
    fd.append("toLocationId", adHocTo);
    fd.append("notes", adHocNotes);
    fetcher.submit(fd, { method: "post" });
    setShowAdHoc(false);
    setAdHocNotes("");
  }

  function handleLoadOnHand(transferId) {
    const fd = new FormData();
    fd.append("intent", "loadOnHand");
    fd.append("id", transferId);
    fetcher.submit(fd, { method: "post" });
  }

  function handleSearchChange(transferId, fromLocationId, toLocationId, val) {
    setItemSearch(prev => ({ ...prev, [transferId]: val }));
    setSearchResults(prev => ({ ...prev, [transferId]: [] }));
    setSelectedResult(prev => ({ ...prev, [transferId]: null }));
    if (debounceTimers.current[transferId]) clearTimeout(debounceTimers.current[transferId]);
    if (!val.trim() || val.trim().length < 2) return;
    debounceTimers.current[transferId] = setTimeout(() => {
      const fd = new FormData();
      fd.append("intent", "searchProducts");
      fd.append("query", val.trim());
      fd.append("transferId", transferId);
      fd.append("fromLocationId", fromLocationId);
      fd.append("toLocationId", toLocationId);
      fetcher.submit(fd, { method: "post" });
    }, 400);
  }

  function handleSelectResult(transferId, result) {
    setSelectedResult(prev => ({ ...prev, [transferId]: result }));
    setSearchResults(prev => ({ ...prev, [transferId]: [] }));
    setItemSearch(prev => ({ ...prev, [transferId]: `${result.productTitle}${result.variantTitle ? ` — ${result.variantTitle}` : ""}` }));
    setItemQty(prev => ({ ...prev, [transferId]: "1" }));
  }

  function handleAddItem(transfer) {
    const result = selectedResult[transfer.id];
    if (!result) return;
    const fd = new FormData();
    fd.append("intent", "addItem");
    fd.append("transferId", transfer.id);
    fd.append("variantId", result.id);
    fd.append("productTitle", result.productTitle);
    fd.append("variantTitle", result.variantTitle);
    fd.append("vendor", result.vendor);
    fd.append("sku", result.sku);
    fd.append("qty", itemQty[transfer.id] ?? "1");
    fd.append("srcOnHand", result.srcOnHand ?? 0);
    fd.append("destOnHand", result.destOnHand ?? 0);
    fetcher.submit(fd, { method: "post" });
    setItemSearch(prev => ({ ...prev, [transfer.id]: "" }));
    setSearchResults(prev => ({ ...prev, [transfer.id]: [] }));
    setSelectedResult(prev => ({ ...prev, [transfer.id]: null }));
    setItemQty(prev => ({ ...prev, [transfer.id]: "" }));
  }

  function handleRegenerate(id) {
    if (!confirm("Regenerate this transfer? Current items will be replaced with fresh inventory data.")) return;
    const fd = new FormData();
    fd.append("intent", "regenerate");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
    setQtyEdits(prev => { const n = { ...prev }; delete n[id]; return n; });
    setRemovedItems(prev => { const n = { ...prev }; delete n[id]; return n; });
    setLoadedOnHand(prev => { const s = new Set(prev); s.delete(id); return s; });
  }

  function handleQtyEdit(transferId, itemId, val) {
    setQtyEdits(prev => ({ ...prev, [transferId]: { ...prev[transferId], [itemId]: val } }));
  }

  function handleRemoveItem(transferId, itemId) {
    setRemovedItems(prev => ({ ...prev, [transferId]: new Set([...(prev[transferId] ?? []), itemId]) }));
  }

  function handleRestoreItem(transferId, itemId) {
    setRemovedItems(prev => {
      const s = new Set(prev[transferId] ?? []);
      s.delete(itemId);
      return { ...prev, [transferId]: s };
    });
  }

  function handleSaveItems(transfer) {
    const edits = qtyEdits[transfer.id] ?? {};
    const removed = removedItems[transfer.id] ?? new Set();
    const updates = transfer.items
      .filter(i => !removed.has(i.id) && edits[i.id] !== undefined)
      .map(i => ({ id: i.id, qty: edits[i.id] }));
    const fd = new FormData();
    fd.append("intent", "updateItems");
    fd.append("id", transfer.id);
    fd.append("updates", JSON.stringify(updates));
    fd.append("removedIds", JSON.stringify([...removed]));
    fetcher.submit(fd, { method: "post" });
    setQtyEdits(prev => { const n = { ...prev }; delete n[transfer.id]; return n; });
    setRemovedItems(prev => { const n = { ...prev }; delete n[transfer.id]; return n; });
  }

  function handleStatusChange(id, status) {
    const fd = new FormData();
    fd.append("intent", "updateStatus");
    fd.append("id", id);
    fd.append("status", status);
    fetcher.submit(fd, { method: "post" });
  }

  function handlePushToShopify(id) {
    if (!confirm("Push this transfer to Shopify? Inventory will move between locations immediately.")) return;
    const fd = new FormData();
    fd.append("intent", "pushToShopify");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  function handleDelete(id) {
    if (!confirm("Delete this transfer?")) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  function locationName(id) {
    return locations.find(l => l.id === id)?.name ?? id;
  }

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const templateOptions = templates.map(t => ({ label: t.name, value: t.id }));
  const statusOptions = [
    { label: "Draft", value: "draft" },
    { label: "Sent", value: "sent" },
    { label: "Received", value: "received" },
    { label: "Cancelled", value: "cancelled" },
  ];

  const pushError = fetcher.data?.errors;
  const isLoadingOnHand = isSubmitting && fetcher.formData?.get("intent") === "loadOnHand";

  return (
    <Page
      title="Transfers"
      primaryAction={
        <Button variant="primary" onClick={() => setShowCreate(true)} disabled={templates.length === 0}>
          + New Transfer
        </Button>
      }
      secondaryActions={[
        { content: "+ Ad-hoc Transfer", onAction: () => setShowAdHoc(true) },
        { content: "Manage Templates", onAction: () => setShowTemplates(true) },
      ]}
    >
      <Layout>
        <Layout.Section>

          {pushError?.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner tone="critical">{pushError.join(", ")}</Banner>
            </div>
          )}

          {templates.length === 0 && (
            <Banner tone="info">
              Set up a transfer template first — click "Manage Templates" to get started. Or use "Ad-hoc Transfer" for one-off stock moves.
            </Banner>
          )}

          <Modal
            open={showCreate}
            onClose={() => setShowCreate(false)}
            title="New Transfer"
            primaryAction={{ content: "Generate Transfer", onAction: handleCreate, disabled: !selectedTemplateId }}
            secondaryActions={[{ content: "Cancel", onAction: () => setShowCreate(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="400">
                <Select
                  label="Template"
                  options={templateOptions}
                  value={selectedTemplateId}
                  onChange={setSelectedTemplateId}
                  helpText={selectedTemplate ? `${locationName(selectedTemplate.fromLocationId)} → ${locationName(selectedTemplate.toLocationId)} · ${selectedTemplate.vendors.length} vendors` : ""}
                />
                <Banner tone="info">
                  Only items below min at the destination will be included. Qty is capped by what the source can spare above its own min level.
                </Banner>
                <TextField
                  label="Notes (optional)"
                  value={notes}
                  onChange={setNotes}
                  multiline={2}
                  placeholder="Reason for transfer, etc."
                />
              </BlockStack>
            </Modal.Section>
          </Modal>

          <Modal
            open={showAdHoc}
            onClose={() => setShowAdHoc(false)}
            title="New Ad-hoc Transfer"
            primaryAction={{ content: "Create Transfer", onAction: handleCreateAdHoc }}
            secondaryActions={[{ content: "Cancel", onAction: () => setShowAdHoc(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="400">
                <Select label="From location" options={locationOptions} value={adHocFrom} onChange={setAdHocFrom} />
                <Select label="To location" options={locationOptions} value={adHocTo} onChange={setAdHocTo} />
                <Banner tone="info">
                  A blank transfer will be created. Search for items to add once it's open.
                </Banner>
                <TextField
                  label="Notes (optional)"
                  value={adHocNotes}
                  onChange={setAdHocNotes}
                  multiline={2}
                  placeholder="Reason for transfer, etc."
                />
              </BlockStack>
            </Modal.Section>
          </Modal>

          <Modal
            open={showTemplates}
            onClose={() => setShowTemplates(false)}
            title="Transfer Templates"
            secondaryActions={[{ content: "Done", onAction: () => setShowTemplates(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="400">
                {templates.length === 0 && <Text tone="subdued">No templates yet — create one below.</Text>}
                {templates.map(t => (
                  <Card key={t.id}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text variant="headingSm">{t.name}</Text>
                          <Text tone="subdued">{locationName(t.fromLocationId)} → {locationName(t.toLocationId)}</Text>
                          <Text tone="subdued" variant="bodySm">{t.vendors.length} vendors: {t.vendors.map(v => v.vendor).sort().join(", ")}</Text>
                        </BlockStack>
                        <InlineStack gap="200">
                          <Button variant="plain" onClick={() => handleOpenEditTemplate(t)}>Edit vendors</Button>
                          <Button variant="plain" tone="critical" onClick={() => handleDeleteTemplate(t.id)}>Delete</Button>
                        </InlineStack>
                      </InlineStack>
                    </BlockStack>
                  </Card>
                ))}
                <Divider />
                <Text variant="headingSm">Create new template</Text>
                <TextField label="Template name" value={newTemplateName} onChange={setNewTemplateName} placeholder="e.g. Mineral Point → Willy Street" autoComplete="off" />
                <Select label="From location" options={locationOptions} value={newTemplateFrom} onChange={setNewTemplateFrom} />
                <Select label="To location" options={locationOptions} value={newTemplateTo} onChange={setNewTemplateTo} />
                <Text variant="headingSm">Vendors included ({newTemplateVendors.size} selected)</Text>
                <div style={{ maxHeight: "300px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                  {allVendors.map(v => (
                    <div key={v} style={{ padding: "4px 0" }}>
                      <Checkbox label={v} checked={newTemplateVendors.has(v)} onChange={() => toggleNewVendor(v)} />
                    </div>
                  ))}
                </div>
                <Button variant="primary" onClick={handleCreateTemplate} disabled={!newTemplateName || newTemplateVendors.size === 0}>
                  Save template
                </Button>
              </BlockStack>
            </Modal.Section>
          </Modal>

          {showEditTemplate && (
            <Modal
              open={!!showEditTemplate}
              onClose={() => setShowEditTemplate(null)}
              title={`Edit vendors — ${showEditTemplate.name}`}
              primaryAction={{ content: "Save vendors", onAction: handleSaveEditTemplate }}
              secondaryActions={[{ content: "Cancel", onAction: () => setShowEditTemplate(null) }]}
            >
              <Modal.Section>
                <BlockStack gap="300">
                  <Text tone="subdued">{editVendors.size} vendors selected</Text>
                  <div style={{ maxHeight: "400px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                    {allVendors.map(v => (
                      <div key={v} style={{ padding: "4px 0" }}>
                        <Checkbox label={v} checked={editVendors.has(v)} onChange={() => toggleEditVendor(v)} />
                      </div>
                    ))}
                  </div>
                </BlockStack>
              </Modal.Section>
            </Modal>
          )}

          {isSubmitting && fetcher.formData?.get("intent") === "create" && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <div style={{ marginTop: "1rem" }}>
                <Text>Calculating transfer — checking inventory across locations…</Text>
              </div>
            </div>
          )}

          {transfers.length === 0 && (
            <Card>
              <EmptyState heading="No transfers yet" image="">
                <p>Create a template-based transfer or use Ad-hoc Transfer for one-off stock moves.</p>
              </EmptyState>
            </Card>
          )}

          {transfers.map(transfer => {
            const isExpanded = expandedId === transfer.id;
            const poEdits = qtyEdits[transfer.id] ?? {};
            const poRemoved = removedItems[transfer.id] ?? new Set();
            const hasChanges = Object.keys(poEdits).length > 0 || poRemoved.size > 0;

            const displayItems = transfer.items.map(i => ({
              ...i,
              qty: poEdits[i.id] !== undefined ? Number(poEdits[i.id]) : i.qty,
              removed: poRemoved.has(i.id),
            }));
            const activeItems = displayItems.filter(i => !i.removed);
            const totalUnits = activeItems.reduce((s, i) => s + i.qty, 0);

            const hasOnHandData = transfer.items.some(i => i.srcOnHand > 0 || i.destOnHand > 0);
            const isThisLoadingOnHand = isLoadingOnHand && fetcher.formData?.get("id") === transfer.id;

            const byVendor = {};
            for (const item of activeItems) {
              const v = item.vendor || "Other";
              if (!byVendor[v]) byVendor[v] = [];
              byVendor[v].push(item);
            }

            const tSearchResults = searchResults[transfer.id] ?? [];
            const tSelected = selectedResult[transfer.id];
            const isSearching = isSubmitting &&
              fetcher.formData?.get("intent") === "searchProducts" &&
              fetcher.formData?.get("transferId") === transfer.id;

            const canPush = transfer.status === "draft" && activeItems.length > 0;
            const srcName = locationName(transfer.fromLocationId);
            const destName = locationName(transfer.toLocationId);

            return (
              <div key={transfer.id} style={{ marginBottom: "1rem" }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="headingMd">{transfer.transferNumber}</Text>
                          {statusBadge(transfer.status)}
                          {!transfer.templateId && <Badge tone="attention">Ad-hoc</Badge>}
                        </InlineStack>
                        <Text tone="subdued">
                          {srcName} → {destName}
                          {transfer.template ? ` · ${transfer.template.name}` : ""}
                        </Text>
                        <Text tone="subdued" variant="bodySm">
                          {activeItems.length} SKUs · {totalUnits} units
                          · Created {new Date(transfer.createdAt).toLocaleDateString()}
                          {transfer.notes ? ` · ${transfer.notes}` : ""}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="200" wrap>
                        <Select label="" labelHidden options={statusOptions} value={transfer.status} onChange={val => handleStatusChange(transfer.id, val)} />
                        {transfer.templateId && (
                          <Button variant="plain" onClick={() => handleRegenerate(transfer.id)}>↺ Regenerate</Button>
                        )}
                        <Button variant="plain" onClick={() => downloadPickListCSV(transfer, destName, activeItems)}>
                          ↓ Pick List CSV
                        </Button>
                        {canPush && (
                          <Button variant="primary" onClick={() => handlePushToShopify(transfer.id)}>
                            Push to Shopify
                          </Button>
                        )}
                        <Button variant="plain" onClick={() => setExpandedId(isExpanded ? null : transfer.id)}>
                          {isExpanded ? "Hide items" : "View items"}
                        </Button>
                        <Button variant="plain" tone="critical" onClick={() => handleDelete(transfer.id)}>Delete</Button>
                      </InlineStack>
                    </InlineStack>

                    {isExpanded && (
                      <>
                        <Divider />
                        <BlockStack gap="400">

                          {!hasOnHandData && !isThisLoadingOnHand && (
                            <Banner tone="info">
                              <InlineStack gap="300" blockAlign="center">
                                <Text>On-hand quantities not loaded for this transfer.</Text>
                                <Button variant="plain" onClick={() => handleLoadOnHand(transfer.id)}>
                                  Load on-hand qty
                                </Button>
                              </InlineStack>
                            </Banner>
                          )}
                          {isThisLoadingOnHand && (
                            <Banner tone="info">
                              <InlineStack gap="200" blockAlign="center">
                                <Spinner size="small" />
                                <Text>Loading on-hand quantities…</Text>
                              </InlineStack>
                            </Banner>
                          )}

                          {displayItems.filter(i => i.removed).map(item => (
                            <div key={item.id} style={{ opacity: 0.4 }}>
                              <InlineStack align="space-between">
                                <Text tone="subdued"><s>{item.vendor} · {item.productTitle} · {item.sku}</s></Text>
                                <Button variant="plain" onClick={() => handleRestoreItem(transfer.id, item.id)}>Restore</Button>
                              </InlineStack>
                            </div>
                          ))}

                          {activeItems.length === 0 && !tSelected && (
                            <Banner tone="info">No items yet — search below to add products.</Banner>
                          )}

                          {Object.entries(byVendor).sort(([a], [b]) => a.localeCompare(b)).map(([vendor, items]) => (
                            <BlockStack key={vendor} gap="200">
                              <div style={{ background: "#f6f6f7", padding: "6px 12px", borderRadius: "6px" }}>
                                <Text variant="headingSm">{vendor}</Text>
                              </div>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                                <thead>
                                  <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                                    <th style={{ padding: "6px 12px", textAlign: "left" }}><Text variant="headingSm">Product</Text></th>
                                    <th style={{ padding: "6px 12px", textAlign: "left" }}><Text variant="headingSm">SKU</Text></th>
                                    <th style={{ padding: "6px 12px", textAlign: "right" }}><Text variant="headingSm">{srcName} OH</Text></th>
                                    <th style={{ padding: "6px 12px", textAlign: "right" }}><Text variant="headingSm">Src Min</Text></th>
                                    <th style={{ padding: "6px 12px", textAlign: "right" }}><Text variant="headingSm">{destName} OH</Text></th>
                                    <th style={{ padding: "6px 12px", textAlign: "right" }}><Text variant="headingSm">Dest Need</Text></th>
                                    <th style={{ padding: "6px 12px", textAlign: "right" }}><Text variant="headingSm">Transfer Qty</Text></th>
                                    <th style={{ padding: "6px 12px" }}></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {items.map(item => {
                                    const qty = poEdits[item.id] !== undefined ? poEdits[item.id] : String(item.qty);
                                    const srcOH = item.srcOnHand ?? 0;
                                    const destOH = item.destOnHand ?? 0;
                                    const srcMinVal = item.srcMin ?? 0;
                                    const destNeedVal = item.destNeed ?? 0;
                                    const srcLow = srcOH <= srcMinVal;
                                    return (
                                      <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                        <td style={{ padding: "6px 12px" }}><Text>{item.productTitle}</Text></td>
                                        <td style={{ padding: "6px 12px" }}><Text tone="subdued">{item.sku}</Text></td>
                                        <td style={{ padding: "6px 12px", textAlign: "right" }}>
                                          <Text tone={srcLow ? "critical" : "success"} fontWeight={srcLow ? "semibold" : undefined}>
                                            {hasOnHandData ? srcOH : "—"}
                                          </Text>
                                        </td>
                                        <td style={{ padding: "6px 12px", textAlign: "right" }}>
                                          <Text tone="subdued">{hasOnHandData ? srcMinVal : "—"}</Text>
                                        </td>
                                        <td style={{ padding: "6px 12px", textAlign: "right" }}>
                                          <Text tone={destOH === 0 ? "critical" : "subdued"}>
                                            {hasOnHandData ? destOH : "—"}
                                          </Text>
                                        </td>
                                        <td style={{ padding: "6px 12px", textAlign: "right" }}>
                                          <Text tone="subdued">{hasOnHandData ? destNeedVal : "—"}</Text>
                                        </td>
                                        <td style={{ padding: "6px 12px", width: "90px" }}>
                                          <TextField
                                            label="" labelHidden
                                            type="number"
                                            value={qty}
                                            onChange={val => handleQtyEdit(transfer.id, item.id, val)}
                                            autoComplete="off"
                                          />
                                        </td>
                                        <td style={{ padding: "6px 12px" }}>
                                          <Button variant="plain" tone="critical" onClick={() => handleRemoveItem(transfer.id, item.id)}>
                                            Remove
                                          </Button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </BlockStack>
                          ))}

                          {hasChanges && (
                            <InlineStack align="end">
                              <Button variant="primary" onClick={() => handleSaveItems(transfer)}>Save changes</Button>
                            </InlineStack>
                          )}

                          <Divider />
                          <Text variant="headingSm">Add item</Text>
                          <TextField
                            label="Search by product name or SKU"
                            labelHidden
                            value={itemSearch[transfer.id] ?? ""}
                            onChange={val => handleSearchChange(transfer.id, transfer.fromLocationId, transfer.toLocationId, val)}
                            autoComplete="off"
                            placeholder="Type product name or SKU..."
                            suffix={isSearching ? <Spinner size="small" /> : undefined}
                          />

                          {tSearchResults.length > 0 && (
                            <div style={{
                              background: "#fff",
                              border: "1px solid #e1e3e5",
                              borderRadius: "4px",
                              boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                              maxHeight: "300px",
                              overflowY: "auto",
                              marginTop: "4px",
                            }}>
                              {tSearchResults.map(result => (
                                <div
                                  key={result.id}
                                  onClick={() => handleSelectResult(transfer.id, result)}
                                  style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #f1f2f3" }}
                                  onMouseEnter={e => e.currentTarget.style.background = "#f6f6f7"}
                                  onMouseLeave={e => e.currentTarget.style.background = "#fff"}
                                >
                                  <Text fontWeight="semibold">
                                    {result.productTitle}{result.variantTitle ? ` — ${result.variantTitle}` : ""}
                                  </Text>
                                  <Text tone="subdued" variant="bodySm">
                                    SKU: {result.sku} · {srcName}: <strong>{result.srcOnHand}</strong> · {destName}: <strong>{result.destOnHand}</strong>
                                  </Text>
                                </div>
                              ))}
                            </div>
                          )}

                          {tSelected && (
                            <Card>
                              <BlockStack gap="300">
                                <BlockStack gap="100">
                                  <Text fontWeight="semibold">
                                    {tSelected.productTitle}{tSelected.variantTitle ? ` — ${tSelected.variantTitle}` : ""}
                                  </Text>
                                  <Text tone="subdued">
                                    SKU: {tSelected.sku}
                                    &nbsp;·&nbsp;{srcName} on hand: <strong>{tSelected.srcOnHand}</strong>
                                    &nbsp;·&nbsp;{destName} on hand: <strong>{tSelected.destOnHand}</strong>
                                  </Text>
                                </BlockStack>
                                <InlineStack gap="300" blockAlign="end">
                                  <div style={{ width: "100px" }}>
                                    <TextField
                                      label="Qty to transfer"
                                      type="number"
                                      value={itemQty[transfer.id] ?? "1"}
                                      onChange={val => setItemQty(prev => ({ ...prev, [transfer.id]: val }))}
                                      autoComplete="off"
                                      min="1"
                                    />
                                  </div>
                                  <Button
                                    variant="primary"
                                    onClick={() => handleAddItem(transfer)}
                                    loading={isSubmitting && fetcher.formData?.get("intent") === "addItem"}
                                  >
                                    Add to transfer
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            </Card>
                          )}
                        </BlockStack>
                      </>
                    )}
                  </BlockStack>
                </Card>
              </div>
            );
          })}

        </Layout.Section>
      </Layout>
    </Page>
  );
}