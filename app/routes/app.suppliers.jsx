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
  EmptyState,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { suppliers: [] };
};

export default function Suppliers() {
  const { suppliers } = useLoaderData();

  return (
    <Page
      title="Suppliers"
      primaryAction={<Button variant="primary">Add supplier</Button>}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {suppliers.length === 0 ? (
                <EmptyState
                  heading="No suppliers yet"
                  image=""
                >
                  <p>Add suppliers to track where your products come from.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "text"]}
                  headings={["Supplier", "Email", "SKUs", "Lead Time"]}
                  rows={suppliers.map(s => [
                    s.name,
                    s.email || "—",
                    s.skuCount || 0,
                    s.leadTime ? s.leadTime + " days" : "—",
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}