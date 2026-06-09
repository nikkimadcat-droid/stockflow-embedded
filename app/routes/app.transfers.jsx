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
} from "@shopify/polaris";

function transferNumberGen() {
  const d = new Date();
  return `TR-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 900) + 100}`;
}

function statusBadge(status) {
  const map = { draft: "info", sent: "warning", received: "success", cancelled: "critical" };
  return <Badge tone={map[status] ?? "info"}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}

async function buildMinmaxItems(admin, db, shop, fromLocationId, toLocationId) {
  // get what's below min at the destination
  const minmaxRows = await db.minMax.findMany({
    where: { shop, locationId: toLocationId },
  });
  if (minmaxRows.length === 0) return [];

  const variantIds = minmaxRows.map(m => m.variantId);

  // get on-hand at destination
  const destInvMap = {};
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
                item { variant { id title product { title } } sku }
              }
            }
          }
        }
      }
    `, { variables: { locationId: toLocationId, cursor } });
    const invJson = await invRes.json();
    const levels = invJson.data?.location?.inventoryLevels;
    hasMore = levels?.pageInfo?.hasNextPage ?? false;
    cursor = levels?.pageInfo?.endCursor ?? null;
    for (const e of levels?.edges ?? []) {
      const n = e.node;
      const vid = n.item?.variant?.id;
      if (vid) destInvMap[vid] = {
        qty: n.quantities?.[0]?.quantity ?? 0,
        productTitle: n.item?.variant?.product?.title ?? "",
        variantTitle: n.item?.variant?.title ?? "",
        sku: n.item?.sku ?? "",
      };
    }
  }

  // get on-hand at source so we know what's available to send
  const srcInvMap = {};
  let srcCursor = null;
  let srcHasMore = true;
  while (srcHasMore) {
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
    `, { variables: { locationId: fromLocationId, cursor: srcCursor } });
    const invJson = await invRes.json();
    const levels = invJson.data?.location?.inventoryLevels;
    srcHasMore = levels?.pageInfo?.hasNextPage ?? false;
    srcCursor = levels?.pageInfo?.endCursor ?? null;
    for (const e of levels?.edges ?? []) {
      const n = e.node;
      const vid = n.item?.variant?.id;
      if (vid) srcInvMap[vid] = n.quantities?.[0]?.quantity ?? 0;
    }
  }

  const items = [];
  for (const mm of minmaxRows) {
    const dest = destInvMap[mm.variantId];
    if (!dest) continue;
    const needed = mm.maxLevel - dest.qty;
    if (needed <= 0) continue;
    const srcQty = srcInvMap[mm.variantId] ?? 0;
    if (srcQty <= 0) continue; // nothing to send
    const qty = mm.casePackSize > 1
      ? Math.ceil(needed / mm.casePackSize) * mm.casePackSize
      : needed;
    // cap at what source actually has
    const finalQty = Math.min(qty, srcQty);
    items.push({
      variantId: mm.variantId,
      productTitle: dest.productTitle,
      variantTitle: dest.variantTitle,
      sku: dest.sku,
      qty: finalQty,
      srcQty,
      destQty: dest.qty,
    });
  }
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

  const templates = await db.transferTemplate.findMany({
    where: { shop },
    orderBy: { name: "asc" },
  });

  const transfers = await db.transfer.findMany({
    where: { shop },
    include: { items: true, template: true },
    orderBy: { createdAt: "desc" },
  });

  return { locations, templates, transfers, shop };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  // ── CREATE TEMPLATE ───────────────────────────────────────────
  if (intent === "createTemplate") {
    const name = form.get("name");
    const fromLocationId = form.get("fromLocationId");
    const toLocationId = form.get("toLocationId");
    await db.transferTemplate.create({
      data: { shop, name, fromLocationId, toLocationId, updatedAt: new Date() },
    });
    return { ok: true };
  }

  // ── DELETE TEMPLATE ───────────────────────────────────────────
  if (intent === "deleteTemplate") {
    const id = form.get("id");
    await db.transferTemplate.delete({ where: { id } });
    return { ok: true };
  }

  // ── CREATE TRANSFER ───────────────────────────────────────────
  if (intent === "create") {
    const fromLocationId = form.get("fromLocationId");
    const toLocationId = form.get("toLocationId");
    const templateId = form.get("templateId") || null;
    const mode = form.get("mode");
    const notes = form.get("notes") || "";
    const transferNumber = transferNumberGen();

    let items = [];
    if (mode === "minmax") {
      items = await buildMinmaxItems(admin, db, shop, fromLocationId, toLocationId);
    }
    if (mode === "manual") {
      try { items = JSON.parse(form.get("items") || "[]"); } catch { items = []; }
    }

    await db.transfer.create({
      data: {
        shop,
        transferNumber,
        templateId,
        fromLocationId,
        toLocationId,
        status: "draft",
        notes,
        items: {
          create: items.map(i => ({
            variantId: i.variantId,
            productTitle: i.productTitle,
            variantTitle: i.variantTitle,
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

  // ── REGENERATE ────────────────────────────────────────────────
  if (intent === "regenerate") {
    const id = form.get("id");
    const transfer = await db.transfer.findUnique({ where: { id } });
    if (!transfer) return { ok: false };

    const items = await buildMinmaxItems(admin, db, shop, transfer.fromLocationId, transfer.toLocationId);
    await db.transferItem.deleteMany({ where: { transferId: id } });
    await db.transfer.update({
      where: { id },
      data: {
        updatedAt: new Date(),
        items: {
          create: items.map(i => ({
            variantId: i.variantId,
            productTitle: i.productTitle,
            variantTitle: i.variantTitle,
            sku: i.sku,
            qty: Number(i.qty),
            updatedAt: new Date(),
          })),
        },
      },
    });
    return { ok: true, regenerated: true };
  }

  // ── UPDATE ITEMS ──────────────────────────────────────────────
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

  // ── UPDATE STATUS ─────────────────────────────────────────────
  if (intent === "updateStatus") {
    const id = form.get("id");
    const status = form.get("status");
    await db.transfer.update({ where: { id }, data: { status, updatedAt: new Date() } });
    return { ok: true };
  }

  // ── PUSH TO SHOPIFY ───────────────────────────────────────────
  if (intent === "pushToShopify") {
    const id = form.get("id");
    const transfer = await db.transfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!transfer) return { ok: false };

    // get inventory item IDs for each variant
    const variantIds = transfer.items.map(i => i.variantId);
    const invItemMap = {};

    for (const vid of variantIds) {
      const res = await admin.graphql(`
        query($id: ID!) {
          productVariant(id: $id) {
            inventoryItem { id }
          }
        }
      `, { variables: { id: vid } });
      const json = await res.json();
      const iid = json.data?.productVariant?.inventoryItem?.id;
      if (iid) invItemMap[vid] = iid;
    }

    // move inventory for each item
    const errors = [];
    for (const item of transfer.items) {
      const inventoryItemId = invItemMap[item.variantId];
      if (!inventoryItemId) continue;

      const res = await admin.graphql(`
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

      const json = await res.json();
      const errs = json.data?.inventoryMoveQuantities?.userErrors ?? [];
      if (errs.length > 0) errors.push(...errs.map(e => e.message));
    }

    if (errors.length > 0) return { ok: false, errors };

    await db.transfer.update({
      where: { id },
      data: { status: "sent", updatedAt: new Date() },
    });
    return { ok: true, pushed: true };
  }

  // ── DELETE ────────────────────────────────────────────────────
  if (intent === "delete") {
    const id = form.get("id");
    await db.transfer.delete({ where: { id } });
    return { ok: true };
  }

  return { ok: false };
};

export default function Transfers() {
  const { locations, templates, transfers } = useLoaderData();
  const fetcher = useFetcher();

  const [showCreate, setShowCreate] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [mode, setMode] = useState("minmax");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [fromLocationId, setFromLocationId] = useState(locations[0]?.id ?? "");
  const [toLocationId, setToLocationId] = useState(locations[1]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [qtyEdits, setQtyEdits] = useState({});
  const [removedItems, setRemovedItems] = useState({});

  // template form
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateFrom, setNewTemplateFrom] = useState(locations[0]?.id ?? "");
  const [newTemplateTo, setNewTemplateTo] = useState(locations[1]?.id ?? "");

  const isSubmitting = fetcher.state !== "idle";

  function applyTemplate(templateId) {
    const t = templates.find(t => t.id === templateId);
    if (!t) return;
    setSelectedTemplateId(templateId);
    setFromLocationId(t.fromLocationId);
    setToLocationId(t.toLocationId);
  }

  function handleCreate() {
    const fd = new FormData();
    fd.append("intent", "create");
    fd.append("fromLocationId", fromLocationId);
    fd.append("toLocationId", toLocationId);
    fd.append("templateId", selectedTemplateId);
    fd.append("mode", mode);
    fd.append("notes", notes);
    fetcher.submit(fd, { method: "post" });
    setShowCreate(false);
    setNotes("");
  }

  function handleCreateTemplate() {
    if (!newTemplateName) return;
    const fd = new FormData();
    fd.append("intent", "createTemplate");
    fd.append("name", newTemplateName);
    fd.append("fromLocationId", newTemplateFrom);
    fd.append("toLocationId", newTemplateTo);
    fetcher.submit(fd, { method: "post" });
    setNewTemplateName("");
  }

  function handleDeleteTemplate(id) {
    if (!confirm("Delete this template?")) return;
    const fd = new FormData();
    fd.append("intent", "deleteTemplate");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  function handleRegenerate(id) {
    if (!confirm("Regenerate this transfer? Current items will be replaced with fresh min/max data.")) return;
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
  const templateOptions = [
    { label: "— No template (custom) —", value: "" },
    ...templates.map(t => ({ label: t.name, value: t.id })),
  ];
  const modeOptions = [
    { label: "Auto-fill from Min/Max levels", value: "minmax" },
    { label: "Manual — blank transfer", value: "manual" },
  ];
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
        <Button variant="primary" onClick={() => setShowCreate(true)}>+ New Transfer</Button>
      }
      secondaryActions={[
        { content: "Manage Templates", onAction: () => setShowTemplates(true) },
      ]}
    >
      <Layout>
        <Layout.Section>

          {pushError?.length > 0 && (
            <Banner tone="critical">{pushError.join(", ")}</Banner>
          )}

          {/* ── create transfer modal ── */}
          <Modal
            open={showCreate}
            onClose={() => setShowCreate(false)}
            title="New Transfer"
            primaryAction={{ content: "Generate Transfer", onAction: handleCreate }}
            secondaryActions={[{ content: "Cancel", onAction: () => setShowCreate(false) }]}
          >
            <Modal.Section>
              <BlockStack gap="400">
                <Select
                  label="Use a template"
                  options={templateOptions}
                  value={selectedTemplateId}
                  onChange={applyTemplate}
                  helpText="Templates pre-fill the from/to locations"
                />
                <Select
                  label="From location"
                  options={locationOptions}
                  value={fromLocationId}
                  onChange={setFromLocationId}
                />
                <Select
                  label="To location"
                  options={locationOptions}
                  value={toLocationId}
                  onChange={setToLocationId}
                />
                <Select
                  label="How to populate items"
                  options={modeOptions}
                  value={mode}
                  onChange={setMode}
                />
                {mode === "minmax" && (
                  <Banner tone="info">
                    Items below min at the destination will be auto-populated, capped by available stock at the source.
                  </Banner>
                )}
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
                <Text variant="headingSm">Existing templates</Text>
                {templates.length === 0 && (
                  <Text tone="subdued">No templates yet.</Text>
                )}
                {templates.map(t => (
                  <InlineStack key={t.id} align="space-between" blockAlign="center">
                    <Text>{t.name} — {locationName(t.fromLocationId)} → {locationName(t.toLocationId)}</Text>
                    <Button variant="plain" tone="critical" onClick={() => handleDeleteTemplate(t.id)}>Delete</Button>
                  </InlineStack>
                ))}
                <Divider />
                <Text variant="headingSm">Add new template</Text>
                <TextField
                  label="Template name"
                  value={newTemplateName}
                  onChange={setNewTemplateName}
                  placeholder="e.g. Mineral Point → Willy Street (regular)"
                  autoComplete="off"
                />
                <Select label="From location" options={locationOptions} value={newTemplateFrom} onChange={setNewTemplateFrom} />
                <Select label="To location" options={locationOptions} value={newTemplateTo} onChange={setNewTemplateTo} />
                <Button variant="primary" onClick={handleCreateTemplate} disabled={!newTemplateName}>
                  Save template
                </Button>
              </BlockStack>
            </Modal.Section>
          </Modal>

          {/* ── loading ── */}
          {isSubmitting && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <Text>Working on it — checking min/max levels across locations…</Text>
            </div>
          )}

          {/* ── empty state ── */}
          {!isSubmitting && transfers.length === 0 && (
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
                      <InlineStack gap="200">
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
                          variant="primary"
                          tone="success"
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
                            No items needed — all SKUs at the destination are at or above minimum levels.
                          </Banner>
                        ) : (
                          <BlockStack gap="300">
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead>
                                  <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                                    {["Product", "SKU", "Qty to Transfer", ""].map((h, i) => (
                                      <th key={i} style={{ padding: "8px 12px", textAlign: "left" }}>
                                        <Text variant="headingSm">{h}</Text>
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {displayItems.map(item => {
                                    const qty = poEdits[item.id] !== undefined ? poEdits[item.id] : String(item.qty);

                                    if (item.removed) {
                                      return (
                                        <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3", opacity: 0.4 }}>
                                          <td colSpan={3} style={{ padding: "8px 12px" }}>
                                            <Text tone="subdued"><s>{item.productTitle} — {item.variantTitle}</s></Text>
                                          </td>
                                          <td style={{ padding: "8px 12px" }}>
                                            <Button variant="plain" onClick={() => handleRestoreItem(transfer.id, item.id)}>
                                              Restore
                                            </Button>
                                          </td>
                                        </tr>
                                      );
                                    }

                                    return (
                                      <tr key={item.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                        <td style={{ padding: "8px 12px" }}>
                                          <Text>{item.productTitle}</Text>
                                          <Text tone="subdued" variant="bodySm">{item.variantTitle} · {item.sku}</Text>
                                        </td>
                                        <td style={{ padding: "8px 12px" }}><Text>{item.sku}</Text></td>
                                        <td style={{ padding: "8px 12px", width: "120px" }}>
                                          <TextField
                                            label=""
                                            labelHidden
                                            type="number"
                                            value={qty}
                                            onChange={val => handleQtyEdit(transfer.id, item.id, val)}
                                            autoComplete="off"
                                          />
                                        </td>
                                        <td style={{ padding: "8px 12px" }}>
                                          <Button
                                            variant="plain"
                                            tone="critical"
                                            onClick={() => handleRemoveItem(transfer.id, item.id)}
                                          >
                                            Remove
                                          </Button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                  <tr style={{ borderTop: "2px solid #e1e3e5" }}>
                                    <td colSpan={2} style={{ padding: "8px 12px" }}>
                                      <Text variant="headingSm">Total units</Text>
                                    </td>
                                    <td style={{ padding: "8px 12px" }}>
                                      <Text variant="headingSm">{totalUnits}</Text>
                                    </td>
                                    <td />
                                  </tr>
                                </tbody>
                              </table>
                            </div>
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