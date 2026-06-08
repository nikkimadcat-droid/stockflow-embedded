import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { Page, Layout, Card, Text, BlockStack } from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    query {
      shop {
        name
      }
    }
  `);

  const data = await response.json();
  return { shopName: data.data.shop.name };
};

export default function DebugMetafields() {
  const { shopName } = useLoaderData();
  return (
    <Page title="Debug">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd">Connected to: {shopName}</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}