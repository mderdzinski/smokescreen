import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, ShieldCheck } from "lucide-react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Logo } from "../components/ui/logo";

const IAP_CLEAR_URL = "/?gcp-iap-mode=CLEAR_LOGIN_COOKIE";
const AUTO_REDIRECT_MS = 1200;

function clearLocalSession() {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage access can throw in restricted browser modes; safe to ignore.
  }
}

export function SignedOutPage({
  autoRedirect = true,
  redirectDelayMs = AUTO_REDIRECT_MS,
}: {
  autoRedirect?: boolean;
  redirectDelayMs?: number;
} = {}) {
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    clearLocalSession();
  }, []);

  useEffect(() => {
    if (!autoRedirect) {
      return undefined;
    }
    setRedirecting(true);
    const handle = window.setTimeout(() => {
      window.location.assign(IAP_CLEAR_URL);
    }, redirectDelayMs);
    return () => window.clearTimeout(handle);
  }, [autoRedirect, redirectDelayMs]);

  return (
    <main
      aria-labelledby="signed-out-title"
      className="min-h-screen bg-background text-foreground"
    >
      <header className="border-b border-ink-600 bg-surface-inverse">
        <div className="mx-auto flex min-h-header max-w-container items-center px-gutter py-4">
          <Logo inverse size="md" tagline="data broker opt-out" />
        </div>
      </header>
      <div className="mx-auto flex max-w-container justify-center px-gutter py-16">
        <Card className="w-full max-w-[560px]">
          <CardHeader className="items-start gap-3">
            <ShieldCheck aria-hidden="true" className="h-6 w-6 text-brand" />
            <CardTitle id="signed-out-title">You have been signed out</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm text-content-body">
            <p>
              Smokescreen has cleared its local dashboard state. Next,
              Identity-Aware Proxy will clear the IAP session cookie so this
              browser no longer holds a Smokescreen dashboard session.
            </p>
            <p>
              <strong className="font-semibold text-content-strong">
                Note about your Google account.
              </strong>{" "}
              Clearing the IAP session does not sign you out of Google. If your
              browser still has an active Google session, reopening the
              dashboard URL may sign you in again automatically or show a
              Google account picker. To fully sign out of Google, sign out from{" "}
              <a
                className="underline hover:text-content-strong"
                href="https://accounts.google.com/Logout"
                rel="noreferrer noopener"
                target="_blank"
              >
                accounts.google.com
              </a>
              .
            </p>
            <div
              aria-live="polite"
              className="rounded-sm border border-border bg-surface-raised px-3 py-2 text-xs text-content-body"
              data-testid="signed-out-status"
            >
              {redirecting
                ? "Redirecting to IAP to clear the session cookie…"
                : "Ready to clear the IAP session cookie."}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild variant="primary">
                <a
                  data-testid="signed-out-iap-link"
                  href={IAP_CLEAR_URL}
                  rel="noreferrer"
                >
                  <ExternalLink aria-hidden="true" />
                  <span>Clear IAP session now</span>
                </a>
              </Button>
              <Button asChild variant="outline">
                <Link to="/">Return to dashboard</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

export default SignedOutPage;
