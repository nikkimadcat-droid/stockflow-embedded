import { useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { Page, Card, BlockStack, Button, Text, Banner } from "@shopify/polaris";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const log = [];
  let totalVariantsUpdated = 0;

  // Step 1: fetch all collections with case_size metafield
  let allCollections = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const res = await admin.graphql(`
      query($cursor: String) {
        collections(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              metafield(namespace: "custom", key: "case_size") {
                value
              }
            }
          }
        }
      }
    `, { variables: { cursor } });
    const json = await res.json();
    const page = json.data?.collections;
    hasMore = page?.pageInfo?.hasNextPage ?? false;
    cursor = page?.pageInfo?.endCursor ?? null;
    for (const { node } of page?.edges ?? []) {
      if (node.metafield?.value) {
        allCollections.push({ id: node.id, title: node.title, caseSize: node.metafield.value });
      }
    }
  }

  log.push(`Found ${allCollections.length} collections with case_size metafield.`);

  // Step 2: for each collection, get all product variants and set case_size
  for (const collection of allCollections) {
    const caseSize = collection.caseSize;
    let variantIds = [];
    let prodCursor = null;
    let prodHasMore = true;

    while (prodHasMore) {
      const res = await admin.graphql(`
        query($id: ID!, $cursor: String) {
          collection(id: $id) {
            products(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  variants(first: 50) {
                    edges { node { id } }
                  }
                }
              }
            }
          }
        }
      `, { variables: { id: collection.id, cursor: prodCursor } });
      const json = await res.json();
      const products = json.data?.collection?.products;
      prodHasMore = products?.pageInfo?.hasNextPage ?? false;
      prodCursor = products?.pageInfo?.endCursor ?? null;
      for (const { node: product } of products?.edges ?? []) {
        for (const { node: variant } of product.variants.edges) {
          variantIds.push(variant.id);
        }
      }
    }

    if (variantIds.length === 0) {
      log.push(`${collection.title}: no variants found, skipping.`);
      continue;
    }

    // Set case_size metafield on each variant in batches of 25
    for (let i = 0; i < variantIds.length; i += 25) {
      const batch = variantIds.slice(i, i + 25);
      const metafieldsInput = batch.map((id) => ({
        ownerId: id,
        namespace: "custom",
        key: "case_size",
        value: String(caseSize),
        type: "number_integer",
      }));
      const mutRes = await admin.graphql(`
        mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }
      `, { variables: { metafields: metafieldsInput } });
      const mutJson = await mutRes.json();
      const errors = mutJson.data?.metafieldsSet?.userErrors ?? [];
      if (errors.length > 0) {
        log.push(`${collection.title}: ERRORS — ${errors.map(e => e.message).join(", ")}`);
      } else {
        totalVariantsUpdated += batch.length;
      }
    }

    log.push(`${collection.title} (case size ${caseSize}): ${variantIds.length} variants updated.`);
  }

  log.push(`Done. ${totalVariantsUpdated} variants updated total.`);
  return { log };
};

export default function MigrateCaseSizes() {
  const fetcher = useFetcher();
  const isRunning = fetcher.state !== "idle";
  const log = fetcher.data?.log ?? [];

  return (
    <Page title="Migrate Case Sizes">
      <Card>
        <BlockStack gap="400">
          <Banner tone="warning">
            This tool copies the case_size metafield from each collection down to all its product variants. Run it once. It is safe to re-run — it will just overwrite with the same values.
          </Banner>
          <fetcher.Form method="post">
            <Button variant="primary" submit loading={isRunning} disabled={isRunning}>
              {isRunning ? "Running..." : "Run Migration"}
            </Button>
          </fetcher.Form>
          {log.length > 0 && (
            <BlockStack gap="200">
              {log.map((line, i) => (
                <Text key={i} variant="bodySm" tone={line.includes("ERROR") ? "critical" : line.includes("Done") ? "success" : "subdued"}>
                  {line}
                </Text>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}