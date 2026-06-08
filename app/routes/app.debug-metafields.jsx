import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { Page, Layout, Card, Text, BlockStack } from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    query {
      productVariants(first: 1) {
        edges {
          node {
            sku
            inventoryItem {
              id
              metafields(first: 20) {
                edges {
                  node {
                    namespace
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const data = await response.json();
  const variant = data.data.productVariants.edges[0]?.node;

  return {
    sku: variant?.sku,
    inventoryItemId: variant?.inventoryItem?.id,
    metafields: variant?.inventoryItem?.metafields?.edges?.map(e => e.node) ?? [],
  };
};

export default function DebugMetafields() {
  const { sku, inventoryItemId, metafields } = useLoaderData();

  return (
    <Page title="Metafield Debug">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd">SKU: {sku}</Text>
              <Text tone="subdued">Inventory Item ID: {inventoryItemId}</Text>
              <Text variant="headingMd">Metafields found: {metafields.length}</Text>
              {metafields.length === 0 && (
                <Text tone="critical">No metafields found — Stocky data is gone.</Text>
              )}
              {metafields.map((mf, i) => (
                <Text key={i}>
                  {mf.namespace} / {mf.key}: {mf.value}
                </Text>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}