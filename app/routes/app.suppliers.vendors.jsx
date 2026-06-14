import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  TextField,
  InlineStack,
  Badge,
  Banner,
  RadioButton,
} from "@shopify/polaris";
import { useState } from "react";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const suppliers = await prisma.supplier.findMany({
    where: { shop },
    orderBy: { name: "asc" },
  });

  const supplierLookup = {};
  for (const s of suppliers) supplierLookup[s.id] = s.name;

  const supplierSkuGroups = await prisma.supplierSku.findMany({
    where: { shop },
    select: { vendorName: true, supplierId: true },
    distinct: ["vendorName", "supplierId"],
    orderBy: { vendorName: "asc" },
  });

  const vendorSupplierMap = {};
  for (const row of supplierSkuGroups) {
    if (!row.vendorName) continue;
    if (!vendorSupplierMap[row.vendorName])
      vendorSupplierMap[row.vendorName] = [];
    if (!vendorSupplierMap[row.vendorName].includes(row.supplierId)) {
      vendorSupplierMap[row.vendorName].push(row.supplierId);
    }
  }

  const vendorSuppliers = await prisma.vendorSupplier.findMany({
    where: { shop },
  });
  const primaryMap = {};
  for (const vs of vendorSuppliers) {
    if (vs.isPrimary) primaryMap[vs.vendorName] = vs.supplierId;
  }

  return { vendorSupplierMap, primaryMap, supplierLookup };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

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
          shop_vendorName_supplierId: {
            shop,
            vendorName,
            supplierId: sid,
          },
        },
        update: { isPrimary: sid === supplierId },
        create: {
          shop,
          vendorName,
          supplierId: sid,
          isPrimary: sid === supplierId,
        },
      });
    }

    return { ok: true };
  }

  return { ok: false };
};

export default function VendorSources() {
  const { vendorSupplierMap, primaryMap, supplierLookup } = useLoaderData();
  const fetcher = useFetcher();
  const [search, setSearch] = useState("");

  const handleSetPrimary = (vendorName, supplierId) => {
    const form = new FormData();
    form.append("intent", "set_primary");
    form.append("vendorName", vendorName);
    form.append("supplierId", supplierId);
    fetcher.submit(form, { method: "POST" });
  };

  const saved = fetcher.state === "idle" && fetcher.data?.ok;

  const filteredVendors = Object.entries(vendorSupplierMap)
    .filter(([v]) => v.toLowerCase().includes(search.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));

  const totalVendors = Object.keys(vendorSupplierMap).length;
  const assignedVendors = Object.keys(primaryMap).length;

  return (
    <Page
      title="Vendor Sources"
      backAction={{
        content: "Suppliers",
        onAction: () => window.history.back(),
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
                <Badge>
                  {assignedVendors}/{totalVendors} assigned
                </Badge>
              </InlineStack>

              <TextField
                label="Search vendors"
                value={search}
                onChange={setSearch}
                placeholder="Type to filter..."
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearch("")}
              />

              {filteredVendors.length === 0 ? (
                <Text tone="subdued">No vendors found.</Text>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                      {["Vendor", "Primary supplier", "All distributors"].map(
                        (h) => (
                          <th
                            key={h}
                            style={{ padding: "8px 12px", textAlign: "left" }}
                          >
                            <Text variant="headingSm">{h}</Text>
                          </th>
                        )
                      )}{" "}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVendors.map(([vendorName, supplierIds]) => {
                      const currentPrimary = primaryMap[vendorName] ?? "";
                      return (
                        <tr
                          key={vendorName}
                          style={{ borderBottom: "1px solid #f1f2f3" }}
                        >
                          <td
                            style={{
                              padding: "12px 12px",
                              verticalAlign: "top",
                              whiteSpace: "nowrap",
                              width: "200px",
                            }}
                          >
                            <Text fontWeight="semibold">{vendorName}</Text>
                          </td>
                          <td
                            style={{
                              padding: "12px 12px",
                              verticalAlign: "top",
                            }}
                          >
                            <BlockStack gap="100">
                              {supplierIds.map((sid) => (
                                <RadioButton
                                  key={sid}
                                  label={supplierLookup[sid] ?? sid}
                                  checked={currentPrimary === sid}
                                  id={`${vendorName}-${sid}`}
                                  name={`primary-${vendorName}`}
                                  onChange={() =>
                                    handleSetPrimary(vendorName, sid)
                                  }
                                />
                              ))}
                            </BlockStack>
                          </td>
                          <td
                            style={{
                              padding: "12px 12px",
                              verticalAlign: "top",
                            }}
                          >
                            <BlockStack gap="100">
                              {supplierIds.map((sid) => (
                                <Text
                                  key={sid}
                                  tone={
                                    sid === currentPrimary
                                      ? "success"
                                      : "subdued"
                                  }
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