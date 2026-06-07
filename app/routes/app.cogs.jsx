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

  // Get orders from last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const ordersResponse = await admin.graphql(`
    query {
      orders(first: 250, query: "created_at:>${thirtyDaysAgo.toISOString()}") {
        edges {
          node {
            id
            lineItems(first: 50) {
              edges {
                node {
                  quantity
                  variant {
                    id
                    sku
                    inventoryItem {
                      unitCost { amount }
                    }
                    price
                    product { title }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const ordersData = await ordersResponse.json();
  const orders = ordersData.data.orders.edges.map(e => e.node);

  // Calculate COGS per SKU
  const cogsMap = {};
  let totalCOGS = 0;
  let totalRevenue = 0;

  orders.forEach(order => {
    order.lineItems.edges.forEach(({ node: item }) => {
      if (!item.variant) return;
      const sku = item.variant.sku || item.variant.id;
      const cost = parseFloat(item.variant.inventoryItem?.unitCost?.amount || 0);
      const price = parseFloat(item.variant.price || 0);
      const qty = item.quantity;

      if (!cogsMap[sku]) {
        cogsMap[sku] = {
          product: item.variant.product?.title || "—",
          sku,
          cost,
          price,
          unitsSold: 0,
          cogs: 0,
          revenue: 0,
        };
      }
      cogsMap[sku].unitsSold += qty;
      cogsMap[sku].cogs += cost * qty;
      cogsMap[sku].revenue += price * qty;
      totalCOGS += cost * qty;
      totalRevenue += price * qty;
    });
  });

  const items = Object.values(cogsMap)
    .filter(i => i.unitsSold > 0)
    .sort((a, b) => b.cogs - a.cogs);

  const grossMargin = totalRevenue > 0
    ? ((1 - totalCOGS / totalRevenue) * 100).toFixed(1)
    : 0;

  return { items, totalCOGS, totalRevenue, grossMargin };
};

export default function COGS() {
  const { items, totalCOGS, totalRevenue, grossMargin } = useLoaderData();

  const rows = items.map(i => [
    i.product,
    i.sku || "—",
    i.cost > 0 ? "$" + i.cost.toFixed(2) : "—",
    i.unitsSold,
    "$" + i.cogs.toFixed(2),
    "$" + i.price.toFixed(2),
    i.cost > 0
      ? ((1 - i.cogs / i.revenue) * 100).toFixed(1) + "%"
      : "—",
  ]);

  return (
    <Page title="COGS Tracking">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={4} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">COGS (30d)</Text>
                <Text variant="heading2xl">${totalCOGS.toFixed(0)}</Text>
                <Text tone="subdued">from Shopify cost prices</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Revenue (30d)</Text>
                <Text variant="heading2xl">${totalRevenue.toFixed(0)}</Text>
                <Text tone="subdued">from orders</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Gross Margin</Text>
                <Text variant="heading2xl">{grossMargin}%</Text>
                <Text tone="subdued">from real cost prices</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">SKUs with sales</Text>
                <Text variant="heading2xl">{items.length}</Text>
                <Text tone="subdued">last 30 days</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
              headings={["Product", "SKU", "Cost Price", "Units Sold", "COGS", "Sale Price", "Gross Margin"]}
              rows={rows}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}