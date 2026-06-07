import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  BlockStack,
  Button,
  Select,
} from "@shopify/polaris";
import { useState } from "react";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

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
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  inventoryQuantity
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

  return { locations, products };
};

export default function MinMax() {
  const { locations, products } = useLoaderData();
  const [selectedLocation, setSelectedLocation] = useState(
    locations[0]?.id || ""
  );

  const locationOptions = [
    { label: "All locations (combined)", value: "" },
    ...locations.map(l => ({ label: l.name, value: l.id })),
  ];

  const rows = products.flatMap(p =>
    p.variants.edges.map(({ node: v }) => [
      p.title + (p.variants.edges.length > 1 ? " — " + v.sku : ""),
      v.sku || "—",
      v.inventoryQuantity || 0,
      "0",
      "0",
      "No levels set",
    ])
  );

  return (
    <Page
      title="Min / Max Levels"
      primaryAction={<Button variant="primary">Save all</Button>}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Select
                label="Location"
                options={locationOptions}
                value={selectedLocation}
                onChange={setSelectedLocation}
              />
              <DataTable
                columnContentTypes={["text", "text", "numeric", "text", "text", "text"]}
                headings={["Product", "SKU", "On Hand", "Min Level", "Max Level", "Status"]}
                rows={rows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}