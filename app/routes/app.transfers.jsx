import { useState } from "react";
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
    ["Vendor", "Product", "SKU", "Qty to Pull"],
    ...items.map(i => [i.vendor, i.productTitle, i.sku, i.qty]),
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
  // get all products for these vendors
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
      `, { variables: { cursor, query: `vendor:'${vendor}'` } });
      const json = await res.json();
      const page = json.data.products;
      products.push(...page.edges.map(e => e.node));
      hasMore = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }
  }

  // build variant map
  const variantMap = {};
  for (const p of products) {
    for (const { node: v } of p.variants.edges) {
      variantMap[v.id] = {
        variantId: v.id,
        productTitle: p.title,
        vendor: p.vendor,
        sku: v.sku || "—",
      };
    }
  }
  const variantIds = new Set(Object.keys(variantMap));

  // get min/max at destination
  const destMinMax = {};
  const minmaxRows = await db.minMax.findMany({
    where: { shop, locationId: toLocationId, variantId: { in: [...variantIds] } },
  });
  for (const mm of minmaxRows) {
    destMinMax[mm.variantId] = mm;
  }

  // get min/max at source (for floor)
  const srcMinMax = {};
  const srcMinmaxRows = await db.minMax.findMany({
    where: { shop, locationId: fromLocationId, variantId: { in: [...variantIds] } },
  });
  for (const mm of srcMinmaxRows) {
    srcMinMax[mm.variantId] = mm;
  }

  // paginate inventory at destination
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
      if (vid && variantIds.has(vid)) {
        destInv[vid] = e.node.quantities?.[0]?.quantity ?? 0;
      }
    }
  }

  // paginate inventory at source
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
      if (vid && variantIds.has(vid)) {
        srcInv[vid] = e.node.quantities?.[0]?.quantity ?? 0;
      }
    }
  }

  // calculate transfer quantities
  const items = [];
  for (const [vid, info] of Object.entries(variantMap)) {
    const mm = destMinMax[vid];
    if (!mm) continue; // no min/max set at destination — skip

    const destOnHand = destInv[vid] ?? 0;
    const destNeed = mm.maxLevel - destOnHand;
    if (destNeed <= 0) continue; // destination is stocked up

    const srcOnHand = srcInv[vid] ?? 0;
    const srcMin = srcMinMax[vid]?.minLevel ?? 0;
    const available = srcOnHand - srcMin;
    if (available <= 0) continue; // source has nothing above their own min

    // round need up to case pack
    const casePack = mm.casePackSize || 1;
    const rawQty = Math.min(destNeed, available);
    const qty = casePack > 1
      ? Math.min(Math.ceil(rawQty / casePack) * casePack, available)
      : rawQty;

    if (qty <= 0) continue;

    items.push({
      variantId: vid,
      productTitle: info.productTitle,
      variantTitle: "",
      vendor: info.vendor,
      sku: info.sku,
      qty,
      srcOnHand,
      srcMin,
      available,
      destOnHand,
      destNeed,
    });
  }

  // sort by vendor then product title
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

  // get all vendors from Shopify
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
    for (const { node: p } of page.edges) {
      if (p.vendor) vendors.add(p.vendor);
    }
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

  return {
    locations,
    allVendors: [...vendors].sort(),
    templates,
    transfers,
    shop,
  };
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
        shop, name,
        type: "distribution",
        fromLocationId,
        toLocationId,
        updatedAt: new Date(),
        vendors: {
          create: vendorList.map(v => ({ vendor: v })),
        },
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

    const template = await db.transferTemplate.findUnique({
      where: { id: templateId },
      include: { vendors: true },
    });
    const vendorNames = template?.vendors.map(v => v.vendor) ?? [];

    const items = await buildDistributionItems(
      admin, db, shop, fromLocationId, toLocationId, vendorNames
    );

    await db.transfer.create({
      data: {
        shop, transferNumber, templateId,
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
    const items = await buildDistributionItems(
      admin, db, shop,
      transfer.fromLocationId,
      transfer.toLocationId,
      vendorNames
    );

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
            updatedAt: new Date(),
          })),
        },
      },
    });
    return { ok: true, regenerated: true };
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
    const transfer = await db.transfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!transfer) return { ok: false };

    const errors = [];
    for (const item of transfer.items) {
      // get inventory item ID
      const res = await admin.graphql(`
        query($id: ID!) {
          productVariant(id: $id) {
            inventoryItem { id }
          }
        }
      `, { variables: { id: item.variantId } });
      const json = await res.json();
      const inventoryItemId = json.data?.productVariant?.inventoryItem?.id;
      if (!inventoryItemId) continue;

      const moveRes = await admin.graphql(`
        mutation($input: InventoryMoveQuantitiesInput!) {
          inventoryMoveQuantities(input: $input) {
            userErrors { field message }
          }
        }
      `, {
        variables: {
          input: {
            reason: "redistribution",
            changes: [{
              inventoryItemId,
              fromLocationId: transfer.fromLocationId,
              toLocationId: transfer.toLocationId,
              quantity: item.qty,
              ledgerDocumentUri: `stockflow://transfer/${transfer.transferNumber}`,
            }],
          },
        },
      });

      const moveJson = await moveRes.json();
      const errs = moveJson.data?.inventoryMoveQuantities?.userErrors ?? [];
      if (errs.length > 0) errors.push(...errs.map(e => e.message));
    }

    if (errors.length > 0) return { ok: false, errors };

    await db.transfer.update({
      where: { id },
      data: { status: "sent", updatedAt: new Date() },
    });
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
  const [showTemplates, setShowTemplates] = useState(false);
  const [showEditTemplate, setShowEditTemplate] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [qtyEdits, setQtyEdits] = useState({});
  const [removedItems, setRemovedItems] = useState({});

  // template form state
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateFrom, setNewTemplateFrom] = useState(locations[0]?.id ?? "");
  const [newTemplateTo, setNewTemplateTo] = useState(locations[1]?.id ?? "");
  const [newTemplateVendors, setNewTemplateVendors] = useState(new Set());
  const [editVendors, setEditVendors] = useState(new Set());

  const isSubmitting = fetcher.state !== "idle";

  const selectedTemplate = templates.find(t => t.id === selectedTemplateId);

  function toggleNewVendor(v) {
    setNewTemplateVendors(prev => {
      const s = new Set(prev);
      s.has(v) ? s.delete(v) : s.add(v);
      return s;
    });
  }

  function toggleEditVendor(v) {
    setEditVendors(prev => {
      const s = new Set(prev);
      s.has(v) ? s.delete(v) : s.add(v);
      return s;
    });
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

  function handleRegenerate(id) {
    if (!confirm("Regenerate this transfer? Current items will be replaced with fresh inventory data.")) return;
    const fd = new FormData();
    fd.append("intent", "regenerate");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
    setQtyEdits(prev => { const n = { ...prev }; delete n[id]; return n; });
    setRemovedItems(prev => { const n = { ...prev }; delete n[id]; return n; });
  }

  function handleQtyEdit(transferId, itemId, val) {
    setQtyEdits(prev => ({
      ...prev,
      [transferId]: { ...prev[transferId], [itemId]: val },
    }));
  }

  function handleRemoveItem(transferId, itemId) {
    setRemovedItems(prev => ({
      ...prev,
      [transferId]: new Set([...(prev[transferId] ?? []), itemId]),
    }));
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

  return (
    <Page
      title="Transfers"
      primaryAction={
        <Button variant="primary" onClick={() => setShowCreate(true)} disabled={templates.length === 0}>
          + New Transfer
        </Button>
      }
      secondaryActions={[
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
              Set up a transfer template first — click "Manage Templates" to get started.
            </Banner>
          )}

          {/* ── create transfer modal ── */}
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
                  Items below min at the destination will be auto-populated based on current inventory at the source, capped by the source's own min level.
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

          {/* ── manage templates modal ── */}
          <Modal
            open={showTemplates}
            onClose={() => setShowTemplates(false)}
            title="Transfer Templates"
            secondaryActions={[{ content: "Done", onAction: () => setShowTemplates(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="400">
                {templates.length === 0 && (
                  <Text tone="subdued">No templates yet — create one below.</Text>
                )}
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
                <TextField
                  label="Template name"
                  value={newTemplateName}
                  onChange={setNewTemplateName}
                  placeholder="e.g. Mineral Point → Monroe Street"
                  autoComplete="off"
                />
                <Select label="From location" options={locationOptions} value={newTemplateFrom} onChange={setNewTemplateFrom} />
                <Select label="To location" options={locationOptions} value={newTemplateTo} onChange={setNewTemplateTo} />
                <Text variant="headingSm">Vendors included ({newTemplateVendors.size} selected)</Text>
                <div style={{ maxHeight: "300px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "8px" }}>
                  {allVendors.map(v => (
                    <div key={v} style={{ padding: "4px 0" }}>
                      <Checkbox
                        label={v}
                        checked={newTemplateVendors.has(v)}
                        onChange={() => toggleNewVendor(v)}
                      />
                    </div>
                  ))}
                </div>
                <Button
                  variant="primary"
                  onClick={handleCreateTemplate}
                  disabled={!newTemplateName || newTemplateVendors.size === 0}
                >
                  Save template
                </Button>
              </BlockStack>
            </Modal.Section>
          </Modal>

          {/* ── edit template vendors modal ── */}
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
                        <Checkbox
                          label={v}
                          checked={editVendors.has(v)}
                          onChange={() => toggleEditVendor(v)}
                        />
                      </div>
                    ))}
                  </div>
                </BlockStack>
              </Modal.Section>
            </Modal>
          )}

          {/* ── loading ── */}
          {isSubmitting && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <div style={{ marginTop: "1rem" }}>
                <Text>Calculating transfer — checking inventory across locations…</Text>
              </div>
            </div>
          )}

          {/* ── empty state ── */}
          {!isSubmitting && transfers.length === 0 && templates.length > 0 && (
            <Card>
              <EmptyState heading="No transfers yet" image="">
                <p>Create a transfer to move inventory between your locations.</p>
              </EmptyState>
            </Card>
          )}

          {/* ── transfer list ── */}
          {!isSubmitting && transfers.map(transfer => {
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

            // group by vendor for display
            const byVendor = {};
            for (const item of activeItems) {
              const v = item.vendor || "Other";
              if (!byVendor[v]) byVendor[v] = [];
              byVendor[v].push(item);
            }

            return (
              <div key={transfer.id} style={{ marginBottom: "1rem" }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="headingMd">{transfer.transferNumber}</Text>
                          {statusBadge(transfer.status)}
                        </InlineStack>
                        <Text tone="subdued">
                          {locationName(transfer.fromLocationId)} → {locationName(transfer.toLocationId)}
                          {transfer.template ? ` · ${transfer.template.name}` : ""}
                        </Text>
                        <Text tone="subdued" variant="bodySm">
                          {activeItems.length} SKUs · {totalUnits} units
                          · Created {new Date(transfer.createdAt).toLocaleDateString()}
                          {transfer.notes ? ` · ${transfer.notes}` : ""}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="200" wrap>
                        <Select
                          label=""
                          labelHidden
                          options={statusOptions}
                          value={transfer.status}
                          onChange={val => handleStatusChange(transfer.id, val)}
                        />
                        <Button variant="plain" onClick={() => handleRegenerate(transfer.id)}>
                          ↺ Regenerate
                        </Button>
                        <Button
                          variant="plain"
                          onClick={() => downloadPickListCSV(
                            transfer,
                            locationName(transfer.toLocationId),
                            activeItems
                          )}
                        >
                          ↓ Pick List CSV
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => handlePushToShopify(transfer.id)}
                          disabled={transfer.status === "received" || transfer.status === "cancelled" || activeItems.length === 0}
                        >
                          Push to Shopify
                        </Button>
                        <Button variant="plain" onClick={() => setExpandedId(isExpanded ? null : transfer.id)}>
                          {isExpanded ? "Hide items" : "View items"}
                        </Button>
                        <Button variant="plain" tone="critical" onClick={() => handleDelete(transfer.id)}>
                          Delete
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    {isExpanded && (
                      <>
                        <Divider />
                        {transfer.items.length === 0 ? (
                          <Banner tone="info">
                            No items needed — all SKUs at the destination are at or above minimum levels, or the source has no stock above its own minimum.
                          </Banner>
                        ) : (
                          <BlockStack gap="400">
                            {/* removed items at top */}
                            {displayItems.filter(i => i.removed).map(item => (
                              <div key={item.id} style={{ opacity: 0.4 }}>
                                <InlineStack align="space-between">
                                  <Text tone="subdued"><s>{item.vendor} · {item.productTitle} · {item.sku}</s></Text>
                                  <Button variant="plain" onClick={() => handleRestoreItem(transfer.id, item.id)}>Restore</Button>
                                </InlineStack>
                              </div>
                            ))}

                            {/* grouped by vendor */}
                            {Object.entries(byVendor).sort(([a], [b]) => a.localeCompare(b)).map(([vendor, items]) => (
                              <BlockStack key={vendor} gap="200">
                                <div style={{ background: "#f6f6f7", padding: "6px 12px", borderRadius: "6px" }}>
                                  <Text variant="headingSm">{vendor}</Text>
                                </div>
                                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                  <thead>
                                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                                      <th style={{ padding: "6px 12px", textAlign: "left" }}><Text variant="headingSm">Product</Text></th>
                                      <th style={{ padding: "6px 12px", textAlign: "left" }}><Text variant="headingSm">SKU</Text></th>
                                      <th style={{ padding: "6px 12px", textAlign: "right" }}><Text variant="headingSm">Qty</Text></th>
                                      <th style={{ padding: "6px 12px" }}></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {items.map(item => {
                                      const qty = poEdits[item.id] !== undefined ? poEdits[item.id] : String(item.qty);
                                      return (
                                        <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                          <td style={{ padding: "6px 12px" }}><Text>{item.productTitle}</Text></td>
                                          <td style={{ padding: "6px 12px" }}><Text>{item.sku}</Text></td>
                                          <td style={{ padding: "6px 12px", width: "100px" }}>
                                            <TextField
                                              label=""
                                              labelHidden
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
                                <Button variant="primary" onClick={() => handleSaveItems(transfer)}>
                                  Save changes
                                </Button>
                              </InlineStack>
                            )}
                          </BlockStack>
                        )}
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