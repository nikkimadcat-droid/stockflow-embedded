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

// --- Retry wrapper: Shopify GraphQL throttling shows up as a thrown GraphqlQueryError.
// Backs off and retries a few times before giving up, instead of 500-ing the whole request.
async function graphqlWithRetry(admin, query, opts, retries = 4) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await admin.graphql(query, opts);
    } catch (e) {
      lastErr = e;
      const isThrottled = e?.message?.includes("Throttled") || e?.response?.status === 429;
      if (!isThrottled || i === retries - 1) throw e;
      const delay = 400 * Math.pow(2, i); // 400, 800, 1600, 3200 ms
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// --- Cheap, fixed-cost inventory lookup for a known set of variant IDs.
// Uses the `nodes` query on the variants themselves instead of paginating an
// entire location's inventoryLevels — avoids throttling on large catalogs.
async function fetchInventoryForVariantIds(admin, locationId, variantIds) {
  if (!locationId || variantIds.length === 0) return {};
  const inv = {};
  const chunkSize = 100; // keep well under Shopify's node-array + query-cost limits
  for (let i = 0; i < variantIds.length; i += chunkSize) {
    const chunk = variantIds.slice(i, i + chunkSize);
    const res = await graphqlWithRetry(admin, `
      query($ids: [ID!]!, $locationId: ID!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryItem {
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) { quantity }
              }
            }
          }
        }
      }
    `, { variables: { ids: chunk, locationId } });
    const json = await res.json();
    for (const node of json.data?.nodes ?? []) {
      if (!node?.id) continue;
      inv[node.id] = node.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? 0;
    }
  }
  return inv;
}

async function buildDistributionItems(admin, db, shop, fromLocationId, toLocationId, vendorNames) {
  const products = [];
  for (const vendor of vendorNames) {
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const res = await graphqlWithRetry(admin, `
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
  const variantIds = Object.keys(variantMap);

  const destMinMax = {};
  const minmaxRows = await db.minMax.findMany({
    where: { shop, locationId: toLocationId, variantId: { in: variantIds } },
  });
  for (const mm of minmaxRows) destMinMax[mm.variantId] = mm;

  const srcMinMax = {};
  const srcMinmaxRows = await db.minMax.findMany({
    where: { shop, locationId: fromLocationId, variantId: { in: variantIds } },
  });
  for (const mm of srcMinmaxRows) srcMinMax[mm.variantId] = mm;

  // Only fetch inventory for variants that actually have a dest min/max set —
  // this is usually a much smaller set than the full vendor catalog.
  const relevantVariantIds = variantIds.filter(vid => destMinMax[vid]);

  const [destInv, srcInv] = await Promise.all([
    fetchInventoryForVariantIds(admin, toLocationId, relevantVariantIds),
    fetchInventoryForVariantIds(admin, fromLocationId, relevantVariantIds),
  ]);

  const items = [];
  for (const vid of relevantVariantIds) {
    const info = variantMap[vid];
    const mm = destMinMax[vid];
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

// --- CSV upload helper: resolve a list of SKUs to Shopify variants ---
async function resolveSkusToVariants(admin, skus) {
  const variantMap = {};
  const chunkSize = 40; // keep the query string comfortably under Shopify's search limits
  for (let i = 0; i < skus.length; i += chunkSize) {
    const chunk = skus.slice(i, i + chunkSize);
    const query = chunk.map(s => `sku:'${s.replace(/'/g, "\\'")}'`).join(" OR ");
    const res = await graphqlWithRetry(admin, `
      query($query: String!) {
        productVariants(first: 250, query: $query) {
          edges {
            node {
              id sku title
              product { title vendor }
            }
          }
        }
      }
    `, { variables: { query } });
    const json = await res.json();
    for (const { node: v } of json.data?.productVariants?.edges ?? []) {
      if (!v.sku) continue;
      variantMap[v.sku.trim().toLowerCase()] = {
        variantId: v.id,
        productTitle: v.product?.title ?? "",
        variantTitle: v.title === "Default Title" ? "" : v.title,
        vendor: v.product?.vendor ?? "",
      };
    }
  }
  return variantMap;
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const locRes = await graphqlWithRetry(admin, `
    query { locations(first: 10) { edges { node { id name } } } }
  `);
  const locJson = await locRes.json();
  const locations = locJson.data.locations.edges.map(e => e.node);

  const vendors = new Set();
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const res = await graphqlWithRetry(admin, `
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

    const [srcInv, destInv] = await Promise.all([
      fetchInventoryForVariantIds(admin, transfer.fromLocationId, variantIds),
      fetchInventoryForVariantIds(admin, transfer.toLocationId, variantIds),
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

  if (intent === "uploadCsvItems") {
    const transferId = form.get("transferId");
    const fromLocationId = form.get("fromLocationId");
    const toLocationId = form.get("toLocationId");
    const rows = JSON.parse(form.get("items") || "[]"); // [{ sku, qty }]

    const skus = [...new Set(rows.map(r => (r.sku || "").trim()).filter(Boolean))];
    const variantMap = await resolveSkusToVariants(admin, skus);

    const notFound = [];
    const matched = [];
    for (const row of rows) {
      const key = (row.sku || "").trim().toLowerCase();
      const v = variantMap[key];
      if (!v) { notFound.push(row.sku); continue; }
      matched.push({ ...v, sku: row.sku, qty: Number(row.qty) || 0 });
    }

    if (matched.length === 0) {
      return { ok: true, intent: "uploadCsvItems", transferId, added: 0, notFound };
    }

    const variantIds = matched.map(m => m.variantId);
    const [srcInv, destInv] = await Promise.all([
      fetchInventoryForVariantIds(admin, fromLocationId, variantIds),
      fetchInventoryForVariantIds(admin, toLocationId, variantIds),
    ]);

    const existing = await db.transferItem.findMany({ where: { transferId } });
    const existingByVariant = Object.fromEntries(existing.map(i => [i.variantId, i]));

    for (const m of matched) {
      const srcOnHand = srcInv[m.variantId] ?? 0;
      const destOnHand = destInv[m.variantId] ?? 0;
      const ex = existingByVariant[m.variantId];
      if (ex) {
        await db.transferItem.update({
          where: { id: ex.id },
          data: { qty: ex.qty + m.qty, srcOnHand, destOnHand, updatedAt: new Date() },
        });
      } else {
        await db.transferItem.create({
          data: {
            transferId, variantId: m.variantId,
            productTitle: m.productTitle, variantTitle: m.variantTitle || "",
            vendor: m.vendor, sku: m.sku, qty: m.qty,
            srcOnHand, destOnHand, srcMin: 0, destNeed: 0,
            updatedAt: new Date(),
          },
        });
      }
    }

    return { ok: true, intent: "uploadCsvItems", transferId, added: matched.length, notFound };
  }

  if (intent === "searchProducts") {
    const query = form.get("query");
    const transferId = form.get("transferId");
    const fromLocationId = form.get("fromLocationId");
    const toLocationId = form.get("toLocationId");

    const [titleRes, skuRes] = await Promise.all([
      graphqlWithRetry(admin, `
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
      graphqlWithRetry(admin, `
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

    // Fixed-cost lookup for just the handful of matched variants — no more
    // walking an entire location's inventory on every keystroke.
    const idList = variants.map(v => v.id);
    const [srcOnHandMap, destOnHandMap] = await Promise.all([
      fetchInventoryForVariantIds(admin, fromLocationId, idList),
      toLocationId ? fetchInventoryForVariantIds(admin, toLocationId, idList) : Promise.resolve({}),
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

    // If this variant is already on the transfer, combine quantities instead
    // of creating a duplicate row (mirrors the CSV upload behavior).
    const existing = await db.transferItem.findFirst({ where: { transferId, variantId } });

    if (existing) {
      await db.transferItem.update({
        where: { id: existing.id },
        data: { qty: existing.qty + qty, srcOnHand, destOnHand, updatedAt: new Date() },
      });
    } else {
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
    }

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
    const transfer = await db.transfer.findUnique({ where: { id } });
    if (!transfer) return { ok: false };

    // Mirror the PO page rule: can't be marked received until it's actually
    // been pushed to Shopify (i.e. no longer sitting in draft).
    if (status === "received" && transfer.status === "draft") {
      return { ok: false, errors: ["This transfer must be pushed to Shopify before it can be marked as received."] };
    }

    await db.transfer.update({ where: { id }, data: { status, updatedAt: new Date() } });
    return { ok: true };
  }

  if (intent === "pushToShopify") {
    const id = form.get("id");
    const transfer = await db.transfer.findUnique({ where: { id }, include: { items: true } });
    if (!transfer) return { ok: false };

    // Guard against double-push (duplicate submit, retried request, etc.) —
    // a transfer can only move from draft once.
    if (transfer.status !== "draft") {
      return { ok: false, errors: ["This transfer has already been pushed to Shopify."] };
    }

    const errors = [];
    for (const item of transfer.items) {
      const res = await graphqlWithRetry(admin, `
        query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }
      `, { variables: { id: item.variantId } });
      const json = await res.json();
      const inventoryItemId = json.data?.productVariant?.inventoryItem?.id;
      if (!inventoryItemId) continue;

      const adjRes = await graphqlWithRetry(admin, `
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
  const [csvNotFound, setCsvNotFound] = useState({});
  const [csvAdded, setCsvAdded] = useState({});

  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateFrom, setNewTemplateFrom] = useState(locations[0]?.id ?? "");
  const [newTemplateTo, setNewTemplateTo] = useState(locations[1]?.id ?? "");
  const [newTemplateVendors, setNewTemplateVendors] = useState(new Set());
  const [editVendors, setEditVendors] = useState(new Set());

  const debounceTimers = useRef({});
  const fileInputRefs = useRef({});
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

  if (fetcher.state === "idle" && fetcherData?.intent === "uploadCsvItems" && fetcherData?.transferId) {
    const tid = fetcherData.transferId;
    const nf = fetcherData.notFound ?? [];
    const added = fetcherData.added ?? 0;
    if (JSON.stringify(csvNotFound[tid]) !== JSON.stringify(nf) || csvAdded[tid] !== added) {
      setCsvNotFound(prev => ({ ...prev, [tid]: nf }));
      setCsvAdded(prev => ({ ...prev, [tid]: added }));
      setLoadedOnHand(prev => { const s = new Set(prev); s.delete(tid); return s; });
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

  // --- CSV parsing (handles quoted fields with embedded commas, matches StockFlow PO export layout) ---
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          row.push(field);
          field = "";
        } else if (c === "\n" || c === "\r") {
          if (c === "\r" && text[i + 1] === "\n") i++;
          row.push(field);
          field = "";
          rows.push(row);
          row = [];
        } else {
          field += c;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function handleCsvFile(transfer, file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      const rows = parseCsv(text);
      const headerIdx = rows.findIndex(r => (r[0] || "").trim() === "Vendor");
      if (headerIdx === -1) {
        alert("Couldn't find the item header row (expected a column starting with 'Vendor'). Is this a StockFlow PO export?");
        return;
      }
      const header = rows[headerIdx].map(h => h.trim());
      const skuCol = header.indexOf("SKU");
      const qtyCol = header.indexOf("Qty (Eaches)");
      if (skuCol === -1 || qtyCol === -1) {
        alert("Couldn't find SKU / Qty (Eaches) columns in this CSV.");
        return;
      }
      const items = [];
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.every(c => !c || !c.trim())) continue;
        const sku = (r[skuCol] || "").trim();
        if (!sku || sku.toUpperCase() === "TOTAL") continue;
        const qty = Number(r[qtyCol]);
        if (!qty || qty <= 0) continue;
        items.push({ sku, qty });
      }
      if (items.length === 0) {
        alert("No item rows found in this CSV.");
        return;
      }
      const fd = new FormData();
      fd.append("intent", "uploadCsvItems");
      fd.append("transferId", transfer.id);
      fd.append("fromLocationId", transfer.fromLocationId);
      fd.append("toLocationId", transfer.toLocationId);
      fd.append("items", JSON.stringify(items));
      fetcher.submit(fd, { method: "post" });
    };
    reader.readAsText(file);
  }

  function locationName(id) {
    return locations.find(l => l.id === id)?.name ?? id;
  }

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));
  const templateOptions = templates.map(t => ({ label: t.name, value: t.id }));

  function statusOptionsFor(currentStatus) {
    const all = [
      { label: "Draft", value: "draft" },
      { label: "Sent", value: "sent" },
      { label: "Received", value: "received" },
      { label: "Cancelled", value: "cancelled" },
    ];
    // Mirrors the PO page: can't jump to "received" until it's been pushed
    // to Shopify (status "sent" or later).
    if (currentStatus === "draft") {
      return all.filter(o => o.value !== "received");
    }
    return all;
  }

  const pushError = fetcher.data?.errors;
  const isLoadingOnHand = isSubmitting && fetcher.formData?.get("intent") === "loadOnHand";
  const isUploadingCsv = isSubmitting && fetcher.formData?.get("intent") === "uploadCsvItems";

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
                  A blank transfer will be created. Search for items to add once it's open, or upload a distributor CSV.
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
            const isThisUploadingCsv = isUploadingCsv && fetcher.formData?.get("transferId") === transfer.id;

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

            const notFound = csvNotFound[transfer.id] ?? [];
            const lastAdded = csvAdded[transfer.id];

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
                        <Select label="" labelHidden options={statusOptionsFor(transfer.status)} value={transfer.status} onChange={val => handleStatusChange(transfer.id, val)} />
                        {transfer.templateId && (
                          <Button variant="plain" onClick={() => handleRegenerate(transfer.id)}>↺ Regenerate</Button>
                        )}
                        <input
                          type="file"
                          accept=".csv"
                          style={{ display: "none" }}
                          ref={el => (fileInputRefs.current[transfer.id] = el)}
                          onChange={e => {
                            handleCsvFile(transfer, e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                        <Button
                          variant="plain"
                          onClick={() => fileInputRefs.current[transfer.id]?.click()}
                          loading={isThisUploadingCsv}
                          disabled={isThisUploadingCsv}
                        >
                          ↑ Upload CSV
                        </Button>
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

                    {isThisUploadingCsv && (
                      <Banner tone="info">
                        <InlineStack gap="200" blockAlign="center">
                          <Spinner size="small" />
                          <Text>Matching CSV rows to products…</Text>
                        </InlineStack>
                      </Banner>
                    )}

                    {!isThisUploadingCsv && lastAdded !== undefined && (
                      <Banner tone={notFound.length > 0 ? "warning" : "success"} onDismiss={() => {
                        setCsvAdded(prev => { const n = { ...prev }; delete n[transfer.id]; return n; });
                        setCsvNotFound(prev => { const n = { ...prev }; delete n[transfer.id]; return n; });
                      }}>
                        <BlockStack gap="100">
                          <Text>{lastAdded} item{lastAdded === 1 ? "" : "s"} added from CSV.</Text>
                          {notFound.length > 0 && (
                            <Text>SKUs not found in Shopify: {notFound.join(", ")}</Text>
                          )}
                        </BlockStack>
                      </Banner>
                    )}

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
                            <Banner tone="info">No items yet — search below to add products, or upload a distributor CSV.</Banner>
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