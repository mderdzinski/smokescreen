import { createBrowserRouter } from "react-router-dom";

import { App, NeedsAttentionPage, OverviewPage, SettingsPage, TrustedSendersPage } from "./App";
import { BrokerRegistryPage } from "./pages/BrokerRegistryPage";
import { DesignSystemPage } from "./pages/DesignSystemPage";
import { SignedOutPage } from "./pages/SignedOutPage";

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <App />,
      children: [
        {
          index: true,
          element: <OverviewPage />,
        },
        {
          path: "needs-attention",
          element: <NeedsAttentionPage />,
        },
        {
          path: "brokers",
          element: <BrokerRegistryPage />,
        },
        {
          path: "trusted-senders",
          element: <TrustedSendersPage />,
        },
        {
          path: "settings",
          element: <SettingsPage />,
        },
        {
          path: "design-system",
          element: <DesignSystemPage />,
        },
      ],
    },
    {
      path: "/signed-out",
      element: <SignedOutPage />,
    },
  ],
);
