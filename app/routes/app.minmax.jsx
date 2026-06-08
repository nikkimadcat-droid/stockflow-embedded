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
  Select,
  TextField,
  Banner,
} from "@shopify/polaris";
import { useState, useCallback } from "react";export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const locResponse = await admin.graphql(`
    query {
      locations(first: 10) {
        edges { node { id name } }
      }
    }
  `);
  const locData = await locResponse.json();
  const locations = locData.data.locations.edges.map(e => e.node);

  const prodResponse = await admin.graphql(`
    query {
      products(first: 250) {
        edges {
          node {
            id
            title
            vendor
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                }
              }
            }
          }
        }
      }
    }
  `);
  const prodData = await prodResponse.json();
  const products = prodData.data.products.edges.map(e => e.node);

  const savedMinMax = await prisma.minMax.findMany({ where: { shop } });
  const minMaxMap = {};
  for (const mm of savedMinMax) {
    minMaxMap[`${mm.variantId}__${mm.locationId}`] = mm;
  }

  return { locations, products, minMaxMap, shop };
};
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const updates = JSON.parse(formData.get("updates"));

  for (const u of updates) {
    await prisma.minMax.upsert({
      where: {
        shop_variantId_locationId: {
          shop,
          variantId: u.variantId,
          locationId: u.locationId,
        },
      },
      update: {
        minLevel: parseInt(u.minLevel) || 0,
        maxLevel: parseInt(u.maxLevel) || 0,
        casePackSize: parseInt(u.casePackSize) || 1,
      },
      create: {
        shop,
        variantId: u.variantId,
        locationId: u.locationId,
        minLevel: parseInt(u.minLevel) || 0,
        maxLevel: parseInt(u.maxLevel) || 0,
        casePackSize: parseInt(u.casePackSize) || 1,
      },
    });
  }

  return { ok: true };
};

export default function MinMax() {
  const { locations, products, minMaxMap } = useLoaderData();
  const fetcher = useFetcher();
  const [selectedLocation, setSelectedLocation] = useState(locations[0]?.id || "");
  const [edits, setEdits] = useState({});

  const locationOptions = locations.map(l => ({ label: l.name, value: l.id }));

  const getKey = (variantId, locationId) => `${variantId}__${locationId}`;

  const getValue = (variantId, field) => {
    const key = getKey(variantId, selectedLocation);
    if (edits[key]?.[field] !== undefined) return edits[key][field];
    const saved = minMaxMap[key];
    if (saved) return String(saved[field]);
    return field === "casePackSize" ? "1" : "0";
  };

  const handleChange = useCallback((variantId, field, value) => {
    const key = getKey(variantId, selectedLocation);
    setEdits(prev => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  }, [selectedLocation]);

  const handleSave = () => {
    const updates = [];
    for (const [key, fields] of Object.entries(edits)) {
      const [variantId, locationId] = key.split("__");
      updates.push({
        variantId,
        locationId,
        minLevel: fields.minLevel ?? "0",
        maxLevel: fields.maxLevel ?? "0",
        casePackSize: fields.casePackSize ?? "1",
      });
    }
    if (updates.length === 0) return;
    const form = new FormData();
    form.append("updates", JSON.stringify(updates));
    fetcher.submit(form, { method: "POST" });
    setEdits({});
  };

  const getStatus = (variantId, onHand) => {
    const key = getKey(variantId, selectedLocation);
    const min = parseInt(edits[key]?.minLevel ?? minMaxMap[key]?.minLevel ?? 0);
    if (min === 0) return "—";
    if (onHand <= min) return "⚠️ Reorder";
    return "OK";
  };

  const saved = fetcher.state === "idle" && fetcher.data?.ok;

  return (
    <Page
      title="Min / Max Levels"
      primaryAction={
        <Button variant="primary" onClick={handleSave} loading={fetcher.state !== "idle"}>
          Save changes
        </Button>
      }
    >
      <Layout>
        <Layout.Section>
          {saved && (
            <Banner tone="success" onDismiss={() => {}}>
              Saved successfully.
            </Banner>
          )}
          <Card>
            <BlockStack gap="400">
              <Select
                label="Location"
                options={locationOptions}
                value={selectedLocation}
                onChange={setSelectedLocation}
              />
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      {["Product", "SKU", "Min", "Max", "Case Pack", "Status"].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>
                          <Text variant="headingSm">{h}</Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {products.flatMap(p =>
                      p.variants.edges.map(({ node: v }) => {
                        const status = getStatus(v.id, 0);
                        return (
                          <tr key={v.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                            <td style={{ padding: "8px 12px" }}>
                              <Text>{p.title}</Text>
                              <Text tone="subdued" variant="bodySm">{p.vendor}</Text>
                            </td>
                            <td style={{ padding: "8px 12px" }}>
                              <Text>{v.sku || "—"}</Text>
                            </td>
                            <td style={{ padding: "8px 12px", width: "120px" }}>
                              <TextField
                                label=""
                                labelHidden
                                type="number"
                                value={getValue(v.id, "minLevel")}
                                onChange={val => handleChange(v.id, "minLevel", val)}
                                autoComplete="off"
                              />
                            </td>
                            <td style={{ padding: "8px 12px", width: "120px" }}>
                              <TextField
                                label=""
                                labelHidden
                                type="number"
                                value={getValue(v.id, "maxLevel")}
                                onChange={val => handleChange(v.id, "maxLevel", val)}
                                autoComplete="off"
                              />
                            </td>
                            <td style={{ padding: "8px 12px", width: "120px" }}>
                              <TextField
                                label=""
                                labelHidden
                                type="number"
                                value={getValue(v.id, "casePackSize")}
                                onChange={val => handleChange(v.id, "casePackSize", val)}
                                autoComplete="off"
                              />
                            </td>
                            <td style={{ padding: "8px 12px" }}>
                              <Text tone={status === "⚠️ Reorder" ? "critical" : "subdued"}>
                                {status}
                              </Text>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}