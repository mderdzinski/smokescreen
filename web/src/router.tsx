import { createBrowserRouter } from "react-router-dom";

import { App, NeedsAttentionPage, OverviewPage } from "./App";
import { BrokerRegistryPage } from "./pages/BrokerRegistryPage";

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
      ],
    },
  ],
  {
    basename: "/app",
  },
);
