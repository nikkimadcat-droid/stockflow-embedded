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
  DataTable,
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
  const map = {
    draft: "info",
    ordered: "warning",
    received: "success",
    cancelled: "critical",
  };
  return <Badge tone={map[status] ?? "info"}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
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

  const locRes = await admin.graphql(`
    query {
      locations(first: 10) {
        edges { node { id name } }
      }
    }
  `);
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
    const locationId = form.get("locationId");
    const poNumber = poNumberGen();

    let items = [];

    if (mode === "minmax") {
      const supplierSkus = await db.supplierSku.findMany({
        where: { shop, supplierId },
      });
      const variantIds = supplierSkus.map((s) => s.variantId);

      const minmaxRows = await db.minMax.findMany({
        where: { shop, locationId, variantId: { in: variantIds } },
      });

      const invRes = await admin.graphql(`
        query($locationId: ID!) {
          location(id: $locationId) {
            inventoryLevels(first: 250) {
              edges {
                node {
                  quantities(names: ["available"]) { quantity }
                  item { variant { id title product { title } } sku }
                }
              }
            }
          }
        }
      `, { variables: { locationId } });
      const invJson = await invRes.json();
      const levels = invJson.data?.location?.inventoryLevels?.edges ?? [];

      const onHandMap = {};
      for (const e of levels) {
        const n = e.node;
        const vid = n.item?.variant?.id;
        if (vid) onHandMap[vid] = {
          qty: n.quantities?.[0]?.quantity ?? 0,
          productTitle: n.item?.variant?.product?.title ?? "",
          variantTitle: n.item?.variant?.title ?? "",
          sku: n.item?.sku ?? "",
        };
      }

      for (const mm of minmaxRows) {
        const onHand = onHandMap[mm.variantId];
        if (!onHand) continue;
        const needed = mm.maxLevel - onHand.qty;
        if (needed <= 0) continue;
        const qtyOrdered = mm.casePackSize > 1
          ? Math.ceil(needed / mm.casePackSize) * mm.casePackSize
          : needed;
        const skuRec = supplierSkus.find((s) => s.variantId === mm.variantId);
        items.push({
          variantId: mm.variantId,
          productTitle: onHand.productTitle,
          variantTitle: onHand.variantTitle,
          sku: onHand.sku,
          qtyOrdered,
          qtyCost: skuRec?.cost ?? 0,
        });
      }
    }

    if (mode === "sales") {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString();

      const supplierSkus = await db.supplierSku.findMany({
        where: { shop, supplierId },
      });
      const variantIds = new Set(supplierSkus.map((s) => s.variantId));

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
                        variant { id title product { title } sku }
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
            if (!vid || !variantIds.has(vid)) continue;
            salesMap[vid] = salesMap[vid] ?? {
              qty: 0,
              productTitle: n.variant?.product?.title ?? "",
              variantTitle: n.variant?.title ?? "",
              sku: n.variant?.sku ?? "",
            };
            salesMap[vid].qty += n.quantity;
          }
        }
      }

      for (const [variantId, data] of Object.entries(salesMap)) {
        if (data.qty === 0) continue;
        const skuRec = supplierSkus.find((s) => s.variantId === variantId);
        items.push({
          variantId,
          productTitle: data.productTitle,
          variantTitle: data.variantTitle,
          sku: data.sku,
          qtyOrdered: data.qty,
          qtyCost: skuRec?.cost ?? 0,
        });
      }
    }

    if (mode === "manual") {
      try {
        items = JSON.parse(form.get("items") || "[]");
      } catch {
        items = [];
      }
    }

    const po = await db.purchaseOrder.create({
      data: {
        shop,
        poNumber,
        supplierId,
        status: "draft",
        notes,
        items: {
          create: items.map((i) => ({
            variantId: i.variantId,
            productTitle: i.productTitle,
            variantTitle: i.variantTitle,
            sku: i.sku,
            qtyOrdered: Number(i.qtyOrdered),
            qtyCost: Number(i.qtyCost),
            updatedAt: new Date(),
          })),
        },
        updatedAt: new Date(),
      },
    });

    return { ok: true, poId: po.id };
  }

  if (intent === "updateStatus") {
    const id = form.get("id");
    const status = form.get("status");
    await db.purchaseOrder.update({
      where: { id },
      data: { status, updatedAt: new Date() },
    });
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
  const { purchaseOrders, suppliers, locations } = useLoaderData();
  const fetcher = useFetcher();

  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState("minmax");
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  const isSubmitting = fetcher.state !== "idle";

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

  const supplierOptions = suppliers.map((s) => ({ label: s.name, value: s.id }));
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));
  const modeOptions = [
    { label: "Reorder from Min/Max (bring to max levels)", value: "minmax" },
    { label: "Reorder from 30-day sales velocity", value: "sales" },
    { label: "Manual — I'll enter quantities", value: "manual" },
  ];
  const statusOptions = [
    { label: "Draft", value: "draft" },
    { label: "Ordered", value: "ordered" },
    { label: "Received", value: "received" },
    { label: "Cancelled", value: "cancelled" },
  ];

  return (
    <Page
      title="Purchase Orders"
      primaryAction={
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          + New PO
        </Button>
      }
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
                {suppliers.length === 0 && (
                  <Banner tone="warning">
                    No suppliers set up yet. Add suppliers first so you can link SKUs and costs.
                  </Banner>
                )}
                <Select
                  label="Supplier"
                  options={supplierOptions}
                  value={supplierId}
                  onChange={setSupplierId}
                />
                <Select
                  label="How to populate items"
                  options={modeOptions}
                  value={mode}
                  onChange={setMode}
                />
                {(mode === "minmax" || mode === "sales") && (
                  <Select
                    label="Location"
                    options={locationOptions}
                    value={locationId}
                    onChange={setLocationId}
                    helpText={
                      mode === "minmax"
                        ? "Check inventory levels at this location against min/max targets"
                        : "Sales are store-wide; inventory will be delivered here"
                    }
                  />
                )}
                {mode === "manual" && (
                  <Banner tone="info">
                    A blank PO will be created. You can add line items after saving.
                  </Banner>
                )}
                <TextField
                  label="Notes (optional)"
                  value={notes}
                  onChange={setNotes}
                  multiline={2}
                  placeholder="Promo code, delivery instructions, etc."
                />
              </BlockStack>
            </Modal.Section>
          </Modal>

          {isSubmitting && (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <Spinner size="large" />
              <Text>Generating purchase order...</Text>
            </div>
          )}

          {!isSubmitting && purchaseOrders.length === 0 && (
            <Card>
              <EmptyState heading="No purchase orders yet" image="">
                <p>Create a PO to track incoming inventory from your suppliers.</p>
              </EmptyState>
            </Card>
          )}

          {!isSubmitting && purchaseOrders.map((po) => {
            const isExpanded = expandedId === po.id;
            const totalCost = po.items.reduce((sum, i) => sum + i.qtyOrdered * i.qtyCost, 0);
            const totalUnits = po.items.reduce((sum, i) => sum + i.qtyOrdered, 0);

            return (
              <div key={po.id} style={{ marginBottom: "1rem" }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text variant="headingMd">{po.poNumber}</Text>
                          {statusBadge(po.status)}
                        </InlineStack>
                        <Text tone="subdued">
                          {po.supplier?.name} · {po.items.length} SKUs · {totalUnits} units · ${totalCost.toFixed(2)}
                        </Text>
                        <Text tone="subdued" variant="bodySm">
                          Created {new Date(po.createdAt).toLocaleDateString()}
                          {po.notes ? ` · ${po.notes}` : ""}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="200">
                        <Select
                          label=""
                          labelHidden
                          options={statusOptions}
                          value={po.status}
                          onChange={(val) => handleStatusChange(po.id, val)}
                        />
                        <Button
                          variant="plain"
                          onClick={() => setExpandedId(isExpanded ? null : po.id)}
                        >
                          {isExpanded ? "Hide items" : "View items"}
                        </Button>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => handleDelete(po.id)}
                        >
                          Delete
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    {isExpanded && (
                      <>
                        <Divider />
                        {po.items.length === 0 ? (
                          <Text tone="subdued">No line items on this PO.</Text>
                        ) : (
                          <DataTable
                            columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric"]}
                            headings={["Product", "Variant", "SKU", "Qty", "Unit Cost", "Line Total"]}
                            rows={po.items.map((item) => [
                              item.productTitle,
                              item.variantTitle,
                              item.sku,
                              item.qtyOrdered,
                              `$${item.qtyCost.toFixed(2)}`,
                              `$${(item.qtyOrdered * item.qtyCost).toFixed(2)}`,
                            ])}
                            totals={["", "", "", totalUnits, "", `$${totalCost.toFixed(2)}`]}
                          />
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
