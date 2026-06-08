export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const locResponse = await admin.graphql(`
    query {
      locations(first: 10) {
        edges { node { id name } }
      }
    }
  `);
  const locData = await locResponse.json();
  const locations = locData.data.locations.edges.map(e => e.node);

  const prodResponse = await admin.graphql(`
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
                }
              }
            }
          }
        }
      }
    }
  `);
  const prodData = await prodResponse.json();
  const products = prodData.data.products.edges.map(e => e.node);

  const savedMinMax = await prisma.minMax.findMany({ where: { shop } });
  const minMaxMap = {};
  for (const mm of savedMinMax) {
    minMaxMap[`${mm.variantId}__${mm.locat