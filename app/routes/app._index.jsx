import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineGrid,
  Badge,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Fetch locations
  const locResponse = await admin.graphql(`
    query {
      locations(first: 10) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `);
  const locData = await locResponse.json();
  const locations = locData.data.locations.edges.map(e => e.node);

  // Fetch product count
  const prodResponse = await admin.graphql(`
    query {
      productsCount {
        count
      }
    }
  `);
  const prodData = await prodResponse.json();
  const productCount = prodData.data.productsCount.count;

  return { locations, productCount };
};

export default function Index() {
  const { locations, productCount } = useLoaderData();

  return (
    <Page title="StockFlow Dashboard">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={4} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Total SKUs</Text>
                <Text variant="heading2xl">{productCount}</Text>
                <Text tone="subdued">across all locations</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Locations</Text>
                <Text variant="heading2xl">{locations.length}</Text>
                <Text tone="subdued">
                  {locations.map(l => l.name).join(", ")}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Open POs</Text>
                <Text variant="heading2xl">0</Text>
                <Text tone="subdued">purchase orders</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Stock Alerts</Text>
                <Text variant="heading2xl">—</Text>
                <Text tone="subdued">loading...</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </Page>
  );
}