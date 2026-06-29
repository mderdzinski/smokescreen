import { AlertTriangle, CheckCircle2, Mail, RefreshCcw, Search, Send, Settings, ShieldCheck } from "lucide-react";

import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Logo } from "../components/ui/logo";
import { Metric } from "../components/ui/metric";
import { StatusPill, type BrokerStatus } from "../components/ui/status-pill";
import { TextField } from "../components/ui/text-field";

const buttonVariants = ["primary", "accent", "secondary", "outline", "ghost", "danger"] as const;
const badgeVariants = ["neutral", "olive", "amber", "success", "danger", "solid", "outline"] as const;
const cardVariants = ["default", "sunken", "flat", "inverse", "accent"] as const;
const statuses: BrokerStatus[] = [
  "PENDING",
  "INITIAL_SENT",
  "AWAITING_RESPONSE",
  "IDENTITY_REQUESTED",
  "IDENTITY_SENT",
  "COMPLETED",
  "REJECTED",
  "NEEDS_MANUAL",
  "FAILED",
];

export function DesignSystemPage() {
  return (
    <section className="mx-auto grid max-w-container gap-6 px-5 py-6 sm:px-6 lg:px-8">
      <Card variant="inverse" pad className="ss-haze">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Logo inverse size="lg" tagline="component primitives" />
          <StatusPill status="AWAITING_RESPONSE" />
        </div>
      </Card>

      <Card label="Core" title="Buttons" action={<Badge variant="olive">6 variants</Badge>}>
        <div className="flex flex-wrap items-center gap-3">
          {buttonVariants.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant === "accent" ? <Send /> : null}
              {variant}
            </Button>
          ))}
          <Button iconOnly aria-label="Settings" variant="ghost">
            <Settings />
          </Button>
          <Button block className="sm:max-w-56" size="lg">
            Block button
          </Button>
        </div>
      </Card>

      <Card label="Core" title="Badges and status">
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2">
            {badgeVariants.map((variant) => (
              <Badge dot key={variant} variant={variant}>
                {variant}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {statuses.map((status) => (
              <StatusPill key={status} status={status} />
            ))}
            <StatusPill label="Not started" tone="idle" />
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Metric icon={<Mail />} label="Working" sub="requests in flight" tone="working" value={7} />
        <Metric icon={<CheckCircle2 />} label="Removed" sub="broker confirmations" tone="done" value={12} />
        <Metric icon={<AlertTriangle />} label="Needs attention" sub="waiting on you" tone="attention" value={2} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {cardVariants.map((variant) => (
          <Card key={variant} pad variant={variant}>
            <div className="ss-label">{variant}</div>
            <p className="mt-3 text-sm leading-6 text-content-muted">Tactical panel surface.</p>
          </Card>
        ))}
      </div>

      <Card label="Core" title="Fields, avatars, and logo">
        <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField icon={<Search />} label="Broker search" placeholder="Search brokers" />
            <TextField error hint="Must be a valid Gmail address." label="Gmail address" placeholder="jane@gmail.com" />
            <TextField hint="Stored locally. Never shared with brokers." label="Anthropic API key" type="password" />
            <TextField label="Notes" multiline placeholder="Broker reply context" rows={3} />
          </div>
          <Card variant="sunken" pad>
            <div className="flex flex-wrap items-center gap-4">
              <Avatar ring size="xl" src="/assets/operator-head.png" />
              <Avatar initials="SS" shape="round" />
              <Avatar initials="OP" size="sm" />
            </div>
            <div className="mt-5 grid gap-3">
              <Logo tagline="data broker opt-out" />
              <Logo showMark={false} size="sm" />
            </div>
          </Card>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Composed shadcn surface</CardTitle>
          <Button size="sm" variant="outline">
            <RefreshCcw />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-brand" />
            <p className="text-sm text-content-muted">
              This card uses the legacy CardHeader/CardTitle/CardContent composition.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
