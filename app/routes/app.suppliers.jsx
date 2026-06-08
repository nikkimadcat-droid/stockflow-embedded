import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  EmptyState,
  Modal,
  TextField,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import { useState } from "react";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const suppliers = await prisma.supplier.findMany({
    where: { shop },
    include: { skus: true },
    orderBy: { name: "asc" },
  });
  return { suppliers };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const name = formData.get("name");
    await prisma.supplier.create({ data: { shop, name } });
    return { ok: true };
  }

  if (intent === "delete") {
    const id = formData.get("id");
    await prisma.supplier.delete({ where: { id } });
    return { ok: true };
  }

  return { ok: false };
};

export default function Suppliers() {
  const { suppliers } = useLoaderData();
  const fetcher = useFetcher();
  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const handleAdd = () => {
    if (!newName.trim()) return;
    const form = new FormData();
    form.append("intent", "create");
    form.append("name", newName.trim());
    fetcher.submit(form, { method: "POST" });
    setNewName("");
    setModalOpen(false);
  };

  const handleDelete = (id) => {
    const form = new FormData();
    form.append("intent", "delete");
    form.append("id", id);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <Page
      title="Suppliers"
      primaryAction={
        <Button variant="primary" onClick={() => setModalOpen(true)}>
          Add supplier
        </Button>
      }
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {suppliers.length === 0 ? (
                <EmptyState heading="No suppliers yet" image="">
                  <p>Add suppliers to track where your products come from.</p>
                </EmptyState>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      {["Supplier", "SKUs linked", ""].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>
                          <Text variant="headingSm">{h}</Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.map(s => (
                      <tr key={s.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td style={{ padding: "8px 12px" }}>
                          <a href={`/app/suppliers/${s.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                            <Text variant="bodyMd">{s.name}</Text>
                          </a>
                        </td>
                        <td style={{ padding: "8px 12px" }}>
                          <Badge>{String(s.skus.length)}</Badge>
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}>
                          <InlineStack gap="200">
                            <Button size="slim" tone="critical" onClick={() => handleDelete(s.id)}>
                              Delete
                            </Button>
                          </InlineStack>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add supplier"
        primaryAction={{ content: "Add", onAction: handleAdd }}
        secondaryActions={[{ content: "Cancel", onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <TextField
            label="Supplier name"
            value={newName}
            onChange={setNewName}
            autoComplete="off"
            placeholder="e.g. Phillips Pet Food & Supplies"
          />
        </Modal.Section>
      </Modal>
    </Page>
  );
}