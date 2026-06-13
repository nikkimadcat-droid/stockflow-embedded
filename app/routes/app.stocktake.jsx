import { useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Page, Card, IndexTable, Badge, Text, EmptyState } from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const stocktakes = await db.stocktake.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { lines: true } } },
  });

  return { stocktakes };
};

export default function Stocktakes() {
  const { stocktakes } = useLoaderData();

  return (
    <Page title="Saved Stocktakes" backAction={{ content: "Stocktake", url: "/app/stocktake" }}>
      <Card>
        {stocktakes.length === 0 ? (
          <EmptyState heading="No saved stocktakes yet" image="">
            <p>Saved and completed stocktakes will appear here.</p>
          </EmptyState>
        ) : (
          <IndexTable
            itemCount={stocktakes.length}
            headings={[
              { title: "Date" },
              { title: "Location" },
              { title: "Filters" },
              { title: "SKUs" },
              { title: "Status" },
              { title: "" },
            ]}
            selectable={false}
          >
            {stocktakes.map((s, i) => (
              <IndexTable.Row id={s.id} key={s.id} position={i}>
                <IndexTable.Cell>
                  <Text>{new Date(s.createdAt).toLocaleString()}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{s.locationName}</IndexTable.Cell>
                <IndexTable.Cell>
                  {[s.vendorFilter, s.typeFilter].filter(Boolean).join(" / ") || "—"}
                </IndexTable.Cell>
                <IndexTable.Cell>{s._count.lines}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={s.status === "completed" ? "success" : "attention"}>
                    {s.status === "completed" ? "Completed" : "In progress"}
                  </Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Link to={`/app/stocktake?load=${s.id}`}>Open</Link>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}