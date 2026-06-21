import { createBrowserRouter } from "react-router-dom";

import { App, NeedsAttentionPage, OverviewPage } from "./App";

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
      ],
    },
  ],
  {
    basename: "/app",
  },
);
