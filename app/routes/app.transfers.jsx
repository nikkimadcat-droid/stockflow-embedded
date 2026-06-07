import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Button,
  EmptyState,
  Select,
  Text,
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

  return { locations, transfers: [] };
};

export default function Transfers() {
  const { locations, transfers } = useLoaderData();
  const [fromLocation, setFromLocation] = useState(locations[0]?.id || "");
  const [toLocation, setToLocation] = useState(locations[1]?.id || locations[0]?.id || "");

  const locationOptions = locations.map(l => ({
    label: l.name,
    value: l.id,
  }));

  return (
    <Page title="Transfers">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">New inventory transfer</Text>
              <Select
                label="From location"
                options={locationOptions}
                value={fromLocation}
                onChange={setFromLocation}
              />
              <Select
                label="To location"
                options={locationOptions}
                value={toLocation}
                onChange={setToLocation}
              />
              <Button variant="primary">Create transfer</Button>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Transfer log</Text>
              <EmptyState heading="No transfers yet" image="">
                <p>Transfers between locations will appear here.</p>
              </EmptyState>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}