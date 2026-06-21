import { createBrowserRouter } from "react-router-dom";

import { App, NeedsAttentionPage, OverviewPage, SettingsPage, TrustedSendersPage } from "./App";
import { BrokerRegistryPage } from "./pages/BrokerRegistryPage";
import { OnboardingPage } from "./pages/OnboardingPage";

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
          path: "onboarding",
          element: <OnboardingPage />,
        },
        {
          path: "settings",
          element: <SettingsPage />,
        },
      ],
    },
  ],
);
