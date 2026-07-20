import { useLoaderData, useFetcher, useNavigate, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  EmptyState,
  Modal,
  TextField,
  InlineStack,
  Badge,
  Select,
  Banner,
  Divider,
  RadioButton,
} from "@shopify/polaris";
import { useState } from "react";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const view = url.searchParams.get("view");

  const suppliers = await prisma.supplier.findMany({
    where: { shop },
    include: { skus: true },
    orderBy: { name: "asc" },
  });

  const supplierLookup = {};
  for (const s of suppliers) supplierLookup[s.id] = s.name;

  if (view === "vendors") {
    const supplierSkuGroups = await prisma.supplierSku.findMany({
      where: { shop },
      select: { vendorName: true, supplierId: true },
      distinct: ["vendorName", "supplierId"],
      orderBy: { vendorName: "asc" },
    });

    const vendorSupplierMap = {};
    for (const row of supplierSkuGroups) {
      if (!row.vendorName) continue;
      if (!vendorSupplierMap[row.vendorName]) vendorSupplierMap[row.vendorName] = [];
      if (!vendorSupplierMap[row.vendorName].includes(row.supplierId)) {
        vendorSupplierMap[row.vendorName].push(row.supplierId);
      }
    }

    const vendorSuppliers = await prisma.vendorSupplier.findMany({ where: { shop } });
    const primaryMap = {};
    for (const vs of vendorSuppliers) {
      if (vs.isPrimary) primaryMap[vs.vendorName] = vs.supplierId;
    }

    return { view: "vendors", suppliers, supplierLookup, vendorSupplierMap, primaryMap };
  }

  const vendorMap = {};
  const variantMap = {};
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const vendorResponse = await admin.graphql(`
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              title
              vendor
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    displayName
                    inventoryItem {
                      id
                      unitCost { amount }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { variables: { cursor } });

    const vendorData = await vendorResponse.json();
    const page = vendorData.data.products;

    for (const { node: p } of page.edges) {
      if (!p.vendor) continue;
      if (!vendorMap[p.vendor]) vendorMap[p.vendor] = [];
      for (const { node: v } of p.variants.edges) {
        const cost = parseFloat(v.inventoryItem?.unitCost?.amount ?? 0);
        vendorMap[p.vendor].push({
          id: v.id,
          sku: v.sku,
          name: v.displayName,
          cost,
          inventoryItemId: v.inventoryItem?.id,
        });
        variantMap[v.id] = {
          sku: v.sku,
          title: p.title,
          displayName: v.displayName,
          cost,
          inventoryItemId: v.inventoryItem?.id,
          vendor: p.vendor,
        };
      }
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return { view: "suppliers", suppliers, supplierLookup, vendorMap, variantMap };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const name = formData.get("name");
    await prisma.supplier.create({ data: { shop, name } });
    return { ok: true };
  }

  if (intent === "delete_supplier") {
    const id = formData.get("id");
    await prisma.supplierSku.deleteMany({ where: { supplierId: id } });
    await prisma.supplier.delete({ where: { id } });
    return { ok: true };
  }

  if (intent === "add_by_vendor") {
    const supplierId = formData.get("supplierId");
    const vendorName = formData.get("vendorName") || "";
    const variants = JSON.parse(formData.get("variants"));
    for (const v of variants) {
      await prisma.supplierSku.upsert({
        where: {
          supplierId_variantId_vendorName: {
            supplierId,
            variantId: v.id,
            vendorName,
          },
        },
        update: { cost: v.cost, supplierCode: v.sku || "" },
        create: {
          shop,
          supplierId,
          variantId: v.id,
          vendorName,
          supplierCode: v.sku || "",
          cost: v.cost,
        },
      });
    }

    if (vendorName) {
      await prisma.vendorSupplier.upsert({
        where: { shop_vendorName_supplierId: { shop, vendorName, supplierId } },
        update: {},
        create: { shop, vendorName, supplierId, isPrimary: true },
      });
    }

    return { ok: true };
  }

  if (intent === "add_single_sku") {
    const supplierId = formData.get("supplierId");
    const variantId = formData.get("variantId");
    const vendorName = formData.get("vendorName") || "";
    const sku = formData.get("sku") || "";
    const cost = parseFloat(formData.get("cost")) || 0;

    await prisma.supplierSku.upsert({
      where: {
        supplierId_variantId_vendorName: {
          supplierId,
          variantId,
          vendorName,
        },
      },
      update: { cost, supplierCode: sku },
      create: {
        shop,
        supplierId,
        variantId,
        vendorName,
        supplierCode: sku,
        cost,
      },
    });

    if (vendorName) {
      await prisma.vendorSupplier.upsert({
        where: { shop_vendorName_supplierId: { shop, vendorName, supplierId } },
        update: {},
        create: { shop, vendorName, supplierId, isPrimary: true },
      });
    }

    return { ok: true };
  }

  if (intent === "update_sku") {
    const id = formData.get("id");
    const supplierCode = formData.get("supplierCode");
    const cost = parseFloat(formData.get("cost")) || 0;
    const inventoryItemId = formData.get("inventoryItemId");

    await prisma.supplierSku.update({
      where: { id },
      data: { supplierCode, cost },
    });

    if (inventoryItemId) {
      try {
        const res = await admin.graphql(`
          mutation($id: ID!, $input: InventoryItemInput!) {
            inventoryItemUpdate(id: $id, input: $input) {
              inventoryItem { id unitCost { amount } }
              userErrors { field message }
            }
          }
        `, {
          variables: {
            id: inventoryItemId,
            input: { unitCost: { amount: cost.toString(), currencyCode: "USD" } },
          },
        });

        const resData = await res.json();
        const userErrors = resData.data?.inventoryItemUpdate?.userErrors;
        if (userErrors?.length) {
          console.error("inventoryItemUpdate userErrors:", userErrors);
        }
      } catch (err) {
        console.error("inventoryItemUpdate failed (cost sync skipped):", err);
      }
    }

    return { ok: true };
  }

  if (intent === "update_skus_bulk") {
    const updates = JSON.parse(formData.get("updates"));

    for (const u of updates) {
      const cost = parseFloat(u.cost) || 0;

      await prisma.supplierSku.update({
        where: { id: u.id },
        data: { supplierCode: u.supplierCode, cost },
      });

      if (u.inventoryItemId) {
        try {
          const res = await admin.graphql(`
            mutation($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { id unitCost { amount } }
                userErrors { field message }
              }
            }
          `, {
            variables: {
              id: u.inventoryItemId,
              input: { unitCost: { amount: cost.toString(), currencyCode: "USD" } },
            },
          });

          const resData = await res.json();
          const userErrors = resData.data?.inventoryItemUpdate?.userErrors;
          if (userErrors?.length) {
            console.error("inventoryItemUpdate userErrors:", userErrors);
          }
        } catch (err) {
          console.error("inventoryItemUpdate bulk failed (cost sync skipped):", err);
        }
      }
    }

    return { ok: true };
  }

  if (intent === "remove_sku") {
    const supplierId = formData.get("supplierId");
    const variantId = formData.get("variantId");
    const vendorName = formData.get("vendorName") || "";
    await prisma.supplierSku.deleteMany({ where: { supplierId, variantId, vendorName } });
    return { ok: true };
  }

  if (intent === "set_primary") {
    const vendorName = formData.get("vendorName");
    const supplierId = formData.get("supplierId");

    const skuSuppliers = await prisma.supplierSku.findMany({
      where: { shop, vendorName },
      select: { supplierId: true },
      distinct: ["supplierId"],
    });

    for (const { supplierId: sid } of skuSuppliers) {
      await prisma.vendorSupplier.upsert({
        where: {
          shop_vendorName_supplierId: { shop, vendorName, supplierId: sid },
        },
        update: { isPrimary: sid === supplierId },
        create: { shop, vendorName, supplierId: sid, isPrimary: sid === supplierId },
      });
    }
    return { ok: true };
  }

  return { ok: false };
};

export default function Suppliers() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [selectedVendor, setSelectedVendor] = useState("");
  const [skuEdits, setSkuEdits] = useState({});
  const [vendorSearch, setVendorSearch] = useState("");
  const [singleSkuSearch, setSingleSkuSearch] = useState("");

  const saved = fetcher.state === "idle" && fetcher.data?.ok;

  if (data.view === "vendors") {
    const { vendorSupplierMap, primaryMap, supplierLookup } = data;

    const handleSetPrimary = (vendorName, supplierId) => {
      const form = new FormData();
      form.append("intent", "set_primary");
      form.append("vendorName", vendorName);
      form.append("supplierId", supplierId);
      fetcher.submit(form, { method: "POST" });
    };

    const filteredVendors = Object.entries(vendorSupplierMap)
      .filter(([v]) => v.toLowerCase().includes(vendorSearch.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));

    const totalVendors = Object.keys(vendorSupplierMap).length;
    const assignedVendors = Object.keys(primaryMap).length;

    return (
      <Page
        title="Vendor Sources"
        backAction={{
          content: "Suppliers",
          onAction: () => navigate("/app/suppliers"),
        }}
      >
        <Layout>
          <Layout.Section>
            {saved && (
              <Banner tone="success" onDismiss={() => {}}>
                Primary supplier saved.
              </Banner>
            )}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <BlockStack gap="100">
                    <Text variant="headingMd">Primary supplier by vendor</Text>
                    <Text variant="bodySm" tone="subdued">
                      Set which distributor is the primary source for each vendor.
                      All others are treated as secondary.
                    </Text>
                  </BlockStack>
                  <Badge>{assignedVendors}/{totalVendors} assigned</Badge>
                </InlineStack>

                <TextField
                  label="Search vendors"
                  value={vendorSearch}
                  onChange={setVendorSearch}
                  placeholder="Type to filter..."
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setVendorSearch("")}
                />

                {filteredVendors.length === 0 ? (
                  <Text tone="subdued">No vendors found.</Text>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                        {["Vendor", "Primary supplier", "All distributors"].map((h) => (
                          <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>
                            <Text variant="headingSm">{h}</Text>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVendors.map(([vendorName, supplierIds]) => {
                        const currentPrimary = primaryMap[vendorName] ?? "";
                        return (
                          <tr key={vendorName} style={{ borderBottom: "1px solid #f1f2f3" }}>
                            <td style={{ padding: "12px 12px", verticalAlign: "top", whiteSpace: "nowrap", width: "200px" }}>
                              <Text fontWeight="semibold">{vendorName}</Text>
                            </td>
                            <td style={{ padding: "12px 12px", verticalAlign: "top" }}>
                              <BlockStack gap="100">
                                {supplierIds.map((sid) => (
                                  <RadioButton
                                    key={sid}
                                    label={supplierLookup[sid] ?? sid}
                                    checked={currentPrimary === sid}
                                    id={`${vendorName}-${sid}`}
                                    name={`primary-${vendorName}`}
                                    onChange={() => handleSetPrimary(vendorName, sid)}
                                  />
                                ))}
                              </BlockStack>
                            </td>
                            <td style={{ padding: "12px 12px", verticalAlign: "top" }}>
                              <BlockStack gap="100">
                                {supplierIds.map((sid) => (
                                  <Text
                                    key={sid}
                                    tone={sid === currentPrimary ? "success" : "subdued"}
                                  >
                                    {supplierLookup[sid] ?? sid}
                                    {sid === currentPrimary ? " ★" : ""}
                                  </Text>
                                ))}
                              </BlockStack>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const { suppliers, vendorMap, variantMap } = data;

  const vendors = Object.keys(vendorMap).sort();
  const vendorOptions = [
    { label: "Select a vendor...", value: "" },
    ...vendors.map((v) => ({ label: v, value: v })),
  ];

  const handleAdd = () => {
    if (!newName.trim()) return;
    const form = new FormData();
    form.append("intent", "create");
    form.append("name", newName.trim());
    fetcher.submit(form, { method: "POST" });
    setNewName("");
    setModalOpen(false);
  };

  const handleDeleteSupplier = (id) => {
    const form = new FormData();
    form.append("intent", "delete_supplier");
    form.append("id", id);
    fetcher.submit(form, { method: "POST" });
    if (expandedId === id) setExpandedId(null);
  };

  const handleAddByVendor = (supplierId) => {
    if (!selectedVendor) return;
    const variants = vendorMap[selectedVendor] ?? [];
    const form = new FormData();
    form.append("intent", "add_by_vendor");
    form.append("supplierId", supplierId);
    form.append("vendorName", selectedVendor);
    form.append("variants", JSON.stringify(variants));
    fetcher.submit(form, { method: "POST" });
    setSelectedVendor("");
  };

  const handleAddSingleSku = (supplierId, variantId, variant) => {
    const form = new FormData();
    form.append("intent", "add_single_sku");
    form.append("supplierId", supplierId);
    form.append("variantId", variantId);
    form.append("vendorName", variant.vendor || "");
    form.append("sku", variant.sku || "");
    form.append("cost", variant.cost ?? 0);
    fetcher.submit(form, { method: "POST" });
    setSingleSkuSearch("");
  };

  const handleSkuEdit = (id, field, value) => {
    setSkuEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  };

  const handleSkuSave = (sku) => {
    const edits = skuEdits[sku.id] ?? {};
    const variant = variantMap[sku.variantId] ?? {};
    const form = new FormData();
    form.append("intent", "update_sku");
    form.append("id", sku.id);
    form.append("supplierCode", edits.supplierCode ?? sku.supplierCode ?? "");
    form.append("cost", edits.cost ?? sku.cost ?? 0);
    form.append("inventoryItemId", variant.inventoryItemId ?? "");
    fetcher.submit(form, { method: "POST" });
    setSkuEdits((prev) => {
      const n = { ...prev };
      delete n[sku.id];
      return n;
    });
  };

  const handleSaveAll = (skus) => {
    const dirtySkus = skus.filter((sku) => skuEdits[sku.id] && Object.keys(skuEdits[sku.id]).length > 0);
    if (dirtySkus.length === 0) return;

    const updates = dirtySkus.map((sku) => {
      const edits = skuEdits[sku.id] ?? {};
      const variant = variantMap[sku.variantId] ?? {};
      return {
        id: sku.id,
        supplierCode: edits.supplierCode ?? sku.supplierCode ?? "",
        cost: edits.cost ?? sku.cost ?? 0,
        inventoryItemId: variant.inventoryItemId ?? "",
      };
    });

    const form = new FormData();
    form.append("intent", "update_skus_bulk");
    form.append("updates", JSON.stringify(updates));
    fetcher.submit(form, { method: "POST" });

    setSkuEdits((prev) => {
      const n = { ...prev };
      dirtySkus.forEach((sku) => delete n[sku.id]);
      return n;
    });
  };

  const handleRemoveSku = (supplierId, variantId, vendorName) => {
    const form = new FormData();
    form.append("intent", "remove_sku");
    form.append("supplierId", supplierId);
    form.append("variantId", variantId);
    form.append("vendorName", vendorName || "");
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <Page
      title="Suppliers"
      primaryAction={
        <Button variant="primary" onClick={() => setModalOpen(true)}>
          Add supplier
        </Button>
      }
      secondaryActions={[
        {
          content: "Vendor sources",
          onAction: () => navigate("/app/suppliers?view=vendors"),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          {saved && (
            <Banner tone="success" onDismiss={() => {}}>
              Saved successfully.
            </Banner>
          )}

          {suppliers.length === 0 ? (
            <Card>
              <EmptyState heading="No suppliers yet" image="">
                <p>Add suppliers to track where your products come from.</p>
              </EmptyState>
            </Card>
          ) : (
            <BlockStack gap="400">
              {suppliers.map((s) => {
                const dirtyCount = s.skus.filter(
                  (sku) => skuEdits[sku.id] && Object.keys(skuEdits[sku.id]).length > 0
                ).length;

                return (
                  <Card key={s.id}>
                    <BlockStack gap="400">
                      <InlineStack align="space-between">
                        <InlineStack gap="300" align="center">
                          <Button
                            variant="plain"
                            onClick={() =>
                              setExpandedId(expandedId === s.id ? null : s.id)
                            }
                          >
                            {expandedId === s.id ? "▼" : "▶"} {s.name}
                          </Button>
                          <Badge>{String(s.skus.length)} SKUs</Badge>
                        </InlineStack>
                        <Button
                          size="slim"
                          tone="critical"
                          onClick={() => handleDeleteSupplier(s.id)}
                        >
                          Delete
                        </Button>
                      </InlineStack>

                      {expandedId === s.id && (
                        <BlockStack gap="400">
                          <Divider />
                          <Text variant="headingSm">Add SKUs by vendor</Text>
                          <Select
                            label="Shopify vendor"
                            options={vendorOptions}
                            value={selectedVendor}
                            onChange={setSelectedVendor}
                          />
                          <Button
                            variant="primary"
                            onClick={() => handleAddByVendor(s.id)}
                            disabled={!selectedVendor}
                            loading={fetcher.state !== "idle"}
                          >
                            Add all SKUs from{" "}
                            {selectedVendor || "selected vendor"}
                          </Button>

                          <Divider />
                          <Text variant="headingSm">Add a single SKU</Text>
                          <TextField
                            label="Search by SKU or product name"
                            labelHidden
                            value={singleSkuSearch}
                            onChange={setSingleSkuSearch}
                            placeholder="Search SKU or product name..."
                            autoComplete="off"
                            clearButton
                            onClearButtonClick={() => setSingleSkuSearch("")}
                          />
                          {singleSkuSearch.trim().length > 1 && (() => {
                            const q = singleSkuSearch.trim().toLowerCase();
                            const matches = Object.entries(variantMap)
                              .filter(([, v]) => {
                                return (
                                  (v.sku && v.sku.toLowerCase().includes(q)) ||
                                  (v.title && v.title.toLowerCase().includes(q)) ||
                                  (v.displayName && v.displayName.toLowerCase().includes(q))
                                );
                              })
                              .slice(0, 8);

                            if (matches.length === 0) {
                              return <Text tone="subdued">No matching products found.</Text>;
                            }

                            return (
                              <BlockStack gap="200">
                                {matches.map(([variantId, v]) => {
                                  const alreadyLinked = s.skus.some(
                                    (sku) => sku.variantId === variantId && sku.vendorName === (v.vendor || "")
                                  );
                                  return (
                                    <InlineStack key={variantId} align="space-between" blockAlign="center">
                                      <BlockStack gap="0">
                                        <Text fontWeight="semibold">
                                          {v.sku || "(no SKU)"} — {v.title}
                                        </Text>
                                        <Text tone="subdued" variant="bodySm">
                                          {v.vendor || "no vendor set"}
                                        </Text>
                                      </BlockStack>
                                      <Button
                                        size="slim"
                                        disabled={alreadyLinked}
                                        onClick={() => handleAddSingleSku(s.id, variantId, v)}
                                        loading={fetcher.state !== "idle"}
                                      >
                                        {alreadyLinked ? "Already added" : "Add"}
                                      </Button>
                                    </InlineStack>
                                  );
                                })}
                              </BlockStack>
                            );
                          })()}

                          {s.skus.length > 0 && (() => {
                            const groups = {};
                            for (const sku of s.skus) {
                              const vendor = sku.vendorName?.trim() || "(no vendor set)";
                              if (!groups[vendor]) groups[vendor] = [];
                              groups[vendor].push(sku);
                            }
                            const sortedVendors = Object.keys(groups).sort((a, b) => a.localeCompare(b));

                            return (
                              <BlockStack gap="300">
                                <Divider />
                                <InlineStack align="space-between">
                                  <Text variant="headingSm">
                                    Linked SKUs ({s.skus.length})
                                  </Text>
                                  {dirtyCount > 0 && (
                                    <Button
                                      variant="primary"
                                      onClick={() => handleSaveAll(s.skus)}
                                      loading={fetcher.state !== "idle"}
                                    >
                                      Save all ({dirtyCount} changed)
                                    </Button>
                                  )}
                                </InlineStack>

                                {sortedVendors.map((vendorName) => {
                                  const groupSkus = groups[vendorName];
                                  const isUnmapped = vendorName === "(no vendor set)";
                                  return (
                                    <BlockStack key={vendorName} gap="100">
                                      <div style={{ background: isUnmapped ? "#fff4e5" : "#f6f6f7", padding: "6px 12px", borderRadius: "6px" }}>
                                        <InlineStack gap="200" blockAlign="center">
                                          <Text variant="headingSm">{vendorName}</Text>
                                          {isUnmapped && <Badge tone="warning">Legacy — no vendor recorded</Badge>}
                                          <Text tone="subdued" variant="bodySm">
                                            {groupSkus.length} SKU{groupSkus.length !== 1 ? "s" : ""}
                                          </Text>
                                        </InlineStack>
                                      </div>
                                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                        <thead>
                                          <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                                            {["SKU", "Product", "Supplier Code", "Cost", ""].map((h) => (
                                              <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>
                                                <Text variant="headingSm">{h}</Text>
                                              </th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {groupSkus.map((sku) => {
                                            const variant = variantMap[sku.variantId] ?? {};
                                            const edits = skuEdits[sku.id] ?? {};
                                            const isDirty = Object.keys(edits).length > 0;
                                            return (
                                              <tr
                                                key={sku.id}
                                                style={{
                                                  borderBottom: "1px solid #f1f2f3",
                                                  background: isDirty ? "#fafafa" : "transparent",
                                                }}
                                              >
                                                <td style={{ padding: "8px 12px" }}>
                                                  <Text>{variant.sku || "—"}</Text>
                                                </td>
                                                <td style={{ padding: "8px 12px" }}>
                                                  <Text>{variant.title || "—"}</Text>
                                                </td>
                                                <td style={{ padding: "8px 12px", width: "150px" }}>
                                                  <TextField
                                                    label=""
                                                    labelHidden
                                                    value={edits.supplierCode ?? sku.supplierCode ?? ""}
                                                    onChange={(val) =>
                                                      handleSkuEdit(sku.id, "supplierCode", val)
                                                    }
                                                    autoComplete="off"
                                                  />
                                                </td>
                                                <td style={{ padding: "8px 12px", width: "160px" }}>
                                                  <TextField
                                                    label=""
                                                    labelHidden
                                                    type="number"
                                                    prefix="$"
                                                    value={String(edits.cost ?? sku.cost ?? 0)}
                                                    onChange={(val) =>
                                                      handleSkuEdit(sku.id, "cost", val)
                                                    }
                                                    autoComplete="off"
                                                  />
                                                </td>
                                                <td style={{ padding: "8px 12px", textAlign: "right" }}>
                                                  <Button
                                                    size="slim"
                                                    tone="critical"
                                                    onClick={() =>
                                                      handleRemoveSku(s.id, sku.variantId, sku.vendorName)
                                                    }
                                                  >
                                                    Remove
                                                  </Button>
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </BlockStack>
                                  );
                                })}

                                {dirtyCount > 0 && (
                                  <InlineStack align="end">
                                    <Button
                                      variant="primary"
                                      onClick={() => handleSaveAll(s.skus)}
                                      loading={fetcher.state !== "idle"}
                                    >
                                      Save all ({dirtyCount} changed)
                                    </Button>
                                  </InlineStack>
                                )}
                              </BlockStack>
                            );
                          })()}
                        </BlockStack>
                      )}
                    </BlockStack>
                  </Card>
                );
              })}
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add supplier"
        primaryAction={{ content: "Add", onAction: handleAdd }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <TextField
            label="Supplier name"
            value={newName}
            onChange={setNewName}
            autoComplete="off"
            placeholder="e.g. Phillips Pet Food & Supplies"
          />
        </Modal.Section>
      </Modal>
    </Page>
  );
}