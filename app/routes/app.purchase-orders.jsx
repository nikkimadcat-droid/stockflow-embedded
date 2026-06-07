import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Button,
  EmptyState,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { purchaseOrders: [] };
};

export default function PurchaseOrders() {
  const { purchaseOrders } = useLoaderData();

  return (
    <Page
      title="Purchase Orders"
      primaryAction={<Button variant="primary">+ New PO</Button>}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <EmptyState heading="No purchase orders yet" image="">
                <p>Create a purchase order to track incoming inventory.</p>
              </EmptyState>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}