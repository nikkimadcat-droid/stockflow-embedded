import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  BlockStack,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Fetch all products with vendor info
  const response = await admin.graphql(`
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
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `);

  const data = await response.json();
  const products = data.data.products.edges.map(e => e.node);

  // Group by vendor
  const vendorMap = {};
  products.forEach(p => {
    if (!p.vendor) return;
    if (!vendorMap[p.vendor]) {
      vendorMap[p.vendor] = { name: p.vendor, skus: 0, totalStock: 0 };
    }
    p.variants.edges.forEach(v => {
      vendorMap[p.vendor].skus++;
      vendorMap[p.vendor].totalStock += v.node.inventoryQuantity || 0;
    });
  });

  const vendors = Object.values(vendorMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return { vendors };
};

export default function Vendors() {
  const { vendors } = useLoaderData();

  const rows = vendors.map(v => [
    v.name,
    v.skus,
    v.totalStock,
  ]);

  return (
    <Page title="Vendors">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">{vendors.length} vendors</Text>
              <DataTable
                columnContentTypes={["text", "numeric", "numeric"]}
                headings={["Vendor", "SKUs", "Total Stock"]}
                rows={rows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}