import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  BlockStack,
  InlineGrid,
  Badge,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [prodResponse, ordersResponse] = await Promise.all([
    admin.graphql(`
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
                    inventoryItem { id }
                  }
                }
              }
            }
          }
        }
      }
    `),
    admin.graphql(`
      query {
        orders(first: 250, query: "created_at:>${thirtyDaysAgo.toISOString()}") {
          edges {
            node {
              lineItems(first: 50) {
                edges {
                  node {
                    quantity
                    variant { id }
                  }
                }
              }
            }
          }
        }
      }
    `)
  ]);

  const prodData = await prodResponse.json();
  const ordersData = await ordersResponse.json();

  const products = prodData.data.products.edges.map(e => e.node);
  const orders = ordersData.data.orders.edges.map(e => e.node);

  // Build sales map
  const salesMap = {};
  orders.forEach(order => {
    order.lineItems.edges.forEach(({ node: item }) => {
      if (!item.variant) return;
      salesMap[item.variant.id] = (salesMap[item.variant.id] || 0) + item.quantity;
    });
  });

  // Build forecast items
  const items = [];
  products.forEach(p => {
    p.variants.edges.forEach(({ node: v }) => {
      const sold = salesMap[v.id] || 0;
      const avgDaily = +(sold / 30).toFixed(2);
      const onHand = v.inventoryQuantity || 0;
      const daysOfStock = avgDaily > 0 ? Math.round(onHand / avgDaily) : null;
      const suggestedOrder = avgDaily > 0 ? Math.max(0, Math.ceil(avgDaily * 30) - onHand) : 0;

      if (sold > 0 || onHand <= 0) {
        items.push({
          label: p.variants.edges.length > 1 ? `${p.title} — ${v.title}` : p.title,
          sku: v.sku || "—",
          avgDaily,
          onHand,
          daysOfStock,
          suggestedOrder,
          status: onHand <= 0 ? "Out of stock" : daysOfStock !== null && daysOfStock < 14 ? "Reorder now" : "OK",
        });
      }
    });
  });

  items.sort((a, b) => (a.daysOfStock ?? 999) - (b.daysOfStock ?? 999));

  const reorderCount = items.filter(i => i.status === "Reorder now" || i.status === "Out of stock").length;

  return { items, reorderCount };
};

export default function Forecasting() {
  const { items, reorderCount } = useLoaderData();

  const rows = items.map(i => [
    i.label,
    i.sku,
    i.avgDaily + " / day",
    i.onHand,
    i.daysOfStock !== null ? i.daysOfStock + " days" : "—",
    i.suggestedOrder || "—",
    i.status,
  ]);

  return (
    <Page title="Demand Forecasting">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={2} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">SKUs to reorder</Text>
                <Text variant="heading2xl">{reorderCount}</Text>
                <Text tone="subdued">need attention</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">SKUs tracked</Text>
                <Text variant="heading2xl">{items.length}</Text>
                <Text tone="subdued">with sales history</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "text", "numeric", "text"]}
              headings={["Product", "SKU", "Avg Daily Sales", "On Hand", "Days of Stock", "Suggested Order", "Status"]}
              rows={rows}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}