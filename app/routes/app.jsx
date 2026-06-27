import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import "@shopify/polaris/build/esm/styles.css";

export const unstable_ssr = false;

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={{}}>
        <s-app-nav>
          <s-link href="/app">Dashboard</s-link>
          <s-link href="/app/vendors">Vendors</s-link>
          <s-link href="/app/suppliers">Suppliers</s-link>
          <s-link href="/app/purchase-orders">Purchase Orders</s-link>
          <s-link href="/app/stocktake">Stocktake</s-link>
          <s-link href="/app/transfers">Transfers</s-link>
          <s-link href="/app/cogs">COGS</s-link>
          <s-link href="/app/minmax">Min / Max Levels</s-link>
          <s-link href="/app/forecasting">Demand Forecasting</s-link>
        </s-app-nav>
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};