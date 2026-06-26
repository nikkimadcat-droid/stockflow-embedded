import { useState } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Button, Text, Badge, Modal, Select, TextField,
  Banner, EmptyState, Spinner,
} from "@shopify/polaris";

export async function clientLoader({ serverLoader }) {
  return serverLoader();
}
clientLoader.hydrate = true;

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

async function buildMinmaxItems(admin, db, shop, supplierId, locationId) {
  const supplierSkus = await db.supplierSku.findMany({ where: { shop, supplierId } });
  const variantIds = supplierSkus.map((s) => s.variantId);
  if (variantIds.length === 0) return [];
  const minmaxRows = await db.minMax.findMany({ where: { shop, locationId, variantId: { in: variantIds } } });
  if (minmaxRows.length === 0) return [];
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
    `, { variables: { locationId, cursor } });
    const invJson = await invRes.json();
    const levels = invJson.data?.location?.inventoryLevels;
    hasMore = levels?.pageInfo?.hasNextPage ?? false;
    cursor = levels?.pageInfo?.endCursor ?? null;
    for (const e of levels?.edges ?? []) {
      const n = e.node, vid = n.item?.variant?.id;
      if (vid) onHandMap[vid] = { qty: n.quantities?.[0]?.quantity ?? 0, productTitle: n.item?.variant?.product?.title ?? "", variantTitle: n.item?.variant?.title ?? "", vendor: n.item?.variant?.product?.vendor ?? "", sku: n.item?.sku ?? "" };
    }
  }
  const items = [];
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
  return items;
}

async function buildSalesItems(admin, db, shop, supplierId) {
  const supplierSkus = await db.supplierSku.findMany({ where: { shop, supplierId } });
  const variantIds = new Set(supplierSkus.map((s) => s.variantId));
  if (variantIds.size === 0) return [];
  const since = new Date(); since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString();
  let cursor = null; const salesMap = {}; let hasMore = true;
  while (hasMore) {
    const ordRes = await admin.graphql(`
      query($cursor: String, $since: String!) {
        orders(first: 50, after: $cursor, query: $since) {
          pageInfo { hasNextPage endCursor }
          edges { node { lineItems(first: 50) { edges { node { variant { id title sku product { title vendor } } quantity } } } } }
        }
      }
    `, { variables: { cursor, since: `created_at:>${sinceStr}` } });
    const ordJson = await ordRes.json();
    const ordData = ordJson.data?.orders;
    hasMore = ordData?.pageInfo?.hasNextPage ?? false;
    cursor = ordData?.pageInfo?.endCursor ?? null;
    for (const o of ordData?.edges ?? []) {
      for (const li of o.node.lineItems.edges) {
        const n = li.node, vid = n.variant?.id;
        if (!vid || !variantIds.has(vid)) continue;
        salesMap[vid] = salesMap[vid] ?? { qty: 0, productTitle: n.variant?.product?.title ?? "", variantTitle: n.variant?.title ?? "", vendor: n.variant?.product?.vendor ?? "", sku: n.variant?.sku ?? "" };
        salesMap[vid].qty += n.quantity;
      }
    }
  }
  const items = [];
  for (const [variantId, data] of Object.entries(salesMap)) {
    if (data.qty === 0) continue;
    const skuRec = supplierSkus.filter((s) => s.variantId === variantId).sort((a, b) => (b.supplierCode ? 1 : 0) - (a.supplierCode ? 1 : 0))[0];
    items.push({ variantId, productTitle: data.productTitle, variantTitle: data.variantTitle, vendor: data.vendor, sku: data.sku, supplierCode: skuRec?.supplierCode ?? "", qtyOrdered: data.qty, casePackSize: 1, qtyCost: skuRec?.cost ?? 0 });
  }
  return items;
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const purchaseOrders = await db.purchaseOrder.findMany({
    where: { shop }, include: { items: true, supplier: true }, orderBy: { createdAt: "desc" },
  });
  const suppliers = await db.supplier.findMany({ where: { shop }, orderBy: { name: "asc" } });
  const locRes = await admin.graphql(`query { locations(first: 10) { edges { node { id name } } } }`);
  const locJson = await locRes.json();
  const locations = locJson.data.locations.edges.map((e) => e.node);
  return { purchaseOrders, suppliers, locations, shop };
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
    const po = await db.purchaseOrder.create({
      data: {
        shop, poNumber, supplierId, status: "draft", mode, locationId, notes,
        items: { create: items.map((i) => ({ variantId: i.variantId, productTitle: i.productTitle, variantTitle: i.variantTitle, vendor: i.vendor ?? "", sku: i.sku, supplierCode: i.supplierCode ?? "", qtyOrdered: Number(i.qtyOrdered), casePackSize: Number(i.casePackSize ?? 1), qtyCost: Number(i.qtyCost), updatedAt: new Date() })) },
        updatedAt: new Date(),
      },
    });
    return { ok: true, poId: po.id };
  }

  if (intent === "updateStatus") {
    const id = form.get("id");
    const status = form.get("status");
    await db.purchaseOrder.update({ where: { id }, data: { status, updatedAt: new Date() } });
    return { ok: true };
  }

  if (intent === "delete") {
    const id = form.get("id");
    await db.purchaseOrder.delete({ where: { id } });
    return { ok: true };
  }

  return { ok: false };
};

export default function PurchaseOrders() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();

  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState("minmax");
  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [notes, setNotes] = useState("");

  if (!data) return (
    <div style={{ textAlign: "center", padding: "4rem" }}>
      <Spinner size="large" />
    </div>
  );

  const { purchaseOrders, suppliers, locations } = data;

  if (supplierId === "" && suppliers.length > 0) setSupplierId(suppliers[0].id);
  if (locationId === "" && locations.length > 0) setLocationId(locations[0].id);

  const isSubmitting = fetcher.state !== "idle";
  const locationNameMap = Object.fromEntries(locations.map((l) => [l.id, l.name]));

  const statusOptions = [
    { label: "Draft", value: "draft" },
    { label: "Ordered", value: "ordered" },
    { label: "Received", value: "received" },
    { label: "Cancelled", value: "cancelled" },
  ];
  const modeOptions = [
    { label: "Reorder from Min/Max (bring to max levels)", value: "minmax" },
    { label: "Reorder from 30-day sales velocity", value: "sales" },
    { label: "Manual — I'll enter quantities", value: "manual" },
  ];

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

  function handleStatusChange(id, status) {
    const fd = new FormData();
    fd.append("intent", "updateStatus");
    fd.append("id", id);
    fd.append("status", status);
    fetcher.submit(fd, { method: "post" });
  }

  function handleDelete(id) {
    if (!confirm("Delete this purchase order?")) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", id);
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <Page
      title="Purchase Orders"
      primaryAction={<Button variant="primary" onClick={() => setShowCreate(true)}>+ New PO</Button>}
    >
      <Layout>
        <Layout.Section>

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
                <Select label="Supplier" options={suppliers.map((s) => ({ label: s.name, value: s.id }))} value={supplierId} onChange={setSupplierId} />
                <Select label="How to populate items" options={modeOptions} value={mode} onChange={setMode} />
                {(mode === "minmax" || mode === "sales") && (
                  <Select
                    label="Location"
                    options={locations.map((l) => ({ label: l.name, value: l.id }))}
                    value={locationId}
                    onChange={setLocationId}
                    helpText={mode === "minmax" ? "Check inventory at this location against min/max targets" : "Sales are store-wide; inventory will be delivered here"}
                  />
                )}
                {mode === "manual" && <Banner tone="info">A blank PO will be created. You can add line items after saving.</Banner>}
                <TextField label="Notes (optional)" value={notes} onChange={setNotes} multiline={2} placeholder="Promo code, delivery instructions, etc." />
              </BlockStack>
            </Modal.Section>
          </Modal>

          {isSubmitting && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <Text>Working on it…</Text>
            </div>
          )}

          {!isSubmitting && purchaseOrders.length === 0 && (
            <Card>
              <EmptyState heading="No purchase orders yet" image="">
                <p>Create a PO to track incoming inventory from your suppliers.</p>
              </EmptyState>
            </Card>
          )}

          {purchaseOrders.map((po) => {
            const locationName = po.locationId ? (locationNameMap[po.locationId] ?? "") : null;
            const totalCost = po.items.reduce((s, i) => s + i.qtyOrdered * i.qtyCost, 0);
            const totalUnits = po.items.reduce((s, i) => s + i.qtyOrdered, 0);

            return (
              <div key={po.id} style={{ marginBottom: "1rem" }}>
                <Card>
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <Text variant="headingMd">{po.poNumber}</Text>
                        {statusBadge(po.status)}
                        <Badge tone="default">{po.mode}</Badge>
                        {locationName && locationBadge(locationName)}
                      </InlineStack>
                      <Text tone="subdued">
                        {po.supplier?.name} · {po.items.length} SKUs · {totalUnits} units · ${totalCost.toFixed(2)}
                      </Text>
                      <Text tone="subdued" variant="bodySm">
                        Created {new Date(po.createdAt).toLocaleDateString("en-US")}
                        {po.notes ? ` · ${po.notes}` : ""}
                      </Text>
                    </BlockStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Select
                        label=" " labelHidden
                        options={statusOptions}
                        value={po.status}
                        onChange={(val) => handleStatusChange(po.id, val)}
                      />
                      <Button variant="primary" onClick={() => navigate(`/app/purchase-orders/${po.id}`)}>
                        View items
                      </Button>
                      <Button variant="plain" tone="critical" onClick={() => handleDelete(po.id)}>Delete</Button>
                    </InlineStack>
                  </InlineStack>
                </Card>
              </div>
            );
          })}

        </Layout.Section>
      </Layout>
    </Page>
  );
}