import { AlertTriangle, CheckCircle2, Mail, RefreshCcw, Search, Send, Settings, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Logo } from "../components/ui/logo";
import { Metric } from "../components/ui/metric";
import { StatusPill, type BrokerStatus } from "../components/ui/status-pill";
import { Switch } from "../components/ui/switch";
import { TextField } from "../components/ui/text-field";

const buttonVariants = ["primary", "accent", "secondary", "outline", "ghost", "danger"] as const;
const buttonSizes = ["sm", "md", "lg"] as const;
const badgeVariants = ["neutral", "olive", "amber", "success", "danger", "solid", "outline"] as const;
const cardVariants = ["default", "sunken", "flat", "inverse", "accent"] as const;
const metricTones = ["neutral", "working", "done", "attention"] as const;
const avatarSizes = ["xs", "sm", "md", "lg", "xl"] as const;
const statuses: BrokerStatus[] = [
  "PENDING",
  "INITIAL_SENT",
  "INITIAL_SENT_PINGED",
  "AWAITING_RESPONSE",
  "AWAITING_RESPONSE_PINGED",
  "INFO_REQUESTED",
  "INFO_REQUESTED_PINGED",
  "FOLLOW_UP_SENT",
  "FOLLOW_UP_SENT_PINGED",
  "COMPLETED",
  "REJECTED",
  "REJECTED_REBUTTED",
  "NEEDS_MANUAL",
  "FAILED",
];

export function DesignSystemPage() {
  const [bareOn, setBareOn] = useState(true);
  const [bareOff, setBareOff] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [dryRun, setDryRun] = useState(false);

  return (
    <section className="mx-auto grid max-w-container gap-6 px-5 py-6 sm:px-6 lg:px-8">
      <Card variant="inverse" pad className="ss-haze">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Logo inverse size="lg" tagline="component primitives" />
          <StatusPill status="AWAITING_RESPONSE" />
        </div>
      </Card>

      <Card label="Core" title="Buttons" action={<Badge variant="olive">6 variants</Badge>}>
        <div className="grid gap-4">
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
          <div className="flex flex-wrap items-center gap-3">
            {buttonSizes.map((size) => (
              <Button key={size} size={size} variant="outline">
                {size}
              </Button>
            ))}
            <Button iconOnly aria-label="Small settings" size="sm" variant="secondary">
              <Settings />
            </Button>
            <Button iconOnly aria-label="Large settings" size="lg" variant="secondary">
              <Settings />
            </Button>
          </div>
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

      <Card label="Core" title="Switch">
        <div className="grid max-w-[420px] gap-4">
          <div className="flex items-center gap-5">
            <Switch aria-label="Active toggle" checked={bareOn} onChange={setBareOn} />
            <Switch aria-label="Inactive toggle" checked={bareOff} onChange={setBareOff} />
            <Switch aria-label="Disabled toggle" checked={false} disabled />
          </div>
          <Switch
            checked={notifications}
            description="Ping me when a broker replies."
            label="Email notifications"
            onChange={setNotifications}
          />
          <Switch
            checked={dryRun}
            description="Prepare work without sending email."
            label="Dry run"
            onChange={setDryRun}
            row
          />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-4">
        {metricTones.map((tone) => (
          <Metric
            icon={
              tone === "done" ? <CheckCircle2 /> : tone === "attention" ? <AlertTriangle /> : <Mail />
            }
            key={tone}
            label={tone === "done" ? "Removed" : tone === "attention" ? "Needs attention" : tone}
            rail={tone !== "neutral"}
            sub={tone === "neutral" ? "baseline readout" : tone === "done" ? "broker confirmations" : "requests in flight"}
            tone={tone}
            value={tone === "neutral" ? 20 : tone === "working" ? 7 : tone === "done" ? 12 : 2}
          />
        ))}
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
              {avatarSizes.map((size) => (
                <Avatar
                  initials={size === "xs" ? undefined : size.toUpperCase()}
                  key={size}
                  ring={size === "xl"}
                  shape={size === "sm" ? "round" : "square"}
                  size={size}
                  src={size === "xl" ? "/assets/operator-head.png" : undefined}
                />
              ))}
            </div>
            <div className="mt-5 grid gap-3">
              <Logo size="lg" tagline="data broker opt-out" />
              <Logo tagline="data broker opt-out" />
              <Logo showMark={false} size="sm" />
              <Logo inverse size="sm" tagline="inverse lockup" />
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
