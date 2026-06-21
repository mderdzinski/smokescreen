import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChangeEvent, FormEvent } from "react";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Globe2,
  Mail,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { ApiError } from "../App";
import {
  api,
  type Broker,
  type BrokerImportInput,
  type BrokerImportResult,
  type BrokerInput,
  type BrokerUpdate,
} from "../lib/api";
import { useBrokers } from "../lib/queries";
import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

interface BrokerFormState {
  id: string;
  name: string;
  domain: string;
  privacy_email: string;
  aliases: string;
  notes: string;
}

interface ImportFormState {
  file: File | null;
  name_col: string;
  email_col: string;
  domain_col: string;
  id_col: string;
  notes_col: string;
}

const emptyBrokerForm: BrokerFormState = {
  id: "",
  name: "",
  domain: "",
  privacy_email: "",
  aliases: "",
  notes: "",
};

const defaultImportForm: ImportFormState = {
  file: null,
  name_col: "name",
  email_col: "privacy_email",
  domain_col: "domain",
  id_col: "id",
  notes_col: "notes",
};

const inputClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

function aliasesToText(aliases: string[]): string {
  return aliases.join(", ");
}

function parseAliases(value: string): string[] {
  return value
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

function brokerToForm(broker: Broker): BrokerFormState {
  return {
    id: broker.id,
    name: broker.name,
    domain: broker.domain,
    privacy_email: broker.privacy_email,
    aliases: aliasesToText(broker.aliases),
    notes: broker.notes,
  };
}

function formToBrokerInput(form: BrokerFormState): BrokerInput {
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    domain: form.domain.trim(),
    privacy_email: form.privacy_email.trim(),
    aliases: parseAliases(form.aliases),
    notes: form.notes.trim(),
  };
}

function formToBrokerUpdate(form: BrokerFormState): BrokerUpdate {
  return {
    name: form.name.trim(),
    domain: form.domain.trim(),
    privacy_email: form.privacy_email.trim(),
    aliases: parseAliases(form.aliases),
    notes: form.notes.trim(),
  };
}

function importInput(form: ImportFormState): BrokerImportInput | null {
  if (!form.file) {
    return null;
  }
  return {
    file: form.file,
    name_col: form.name_col.trim(),
    email_col: form.email_col.trim(),
    domain_col: form.domain_col.trim(),
    id_col: form.id_col.trim(),
    notes_col: form.notes_col.trim(),
  };
}

function brokerMatchesSearch(broker: Broker, query: string): boolean {
  const text = [
    broker.id,
    broker.name,
    broker.domain,
    broker.privacy_email,
    broker.notes,
    ...broker.aliases,
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(query.toLowerCase());
}

export function BrokerRegistryPage() {
  const queryClient = useQueryClient();
  const brokersQuery = useBrokers();
  const brokers = brokersQuery.data ?? [];
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<BrokerFormState>(emptyBrokerForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importForm, setImportForm] = useState<ImportFormState>(defaultImportForm);
  const [importResult, setImportResult] = useState<BrokerImportResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const filteredBrokers = useMemo(
    () => brokers.filter((broker) => brokerMatchesSearch(broker, search)),
    [brokers, search],
  );

  const invalidateBrokerData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["brokers"] }),
      queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
      queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: api.createBroker,
    onSuccess: async () => {
      setForm(emptyBrokerForm);
      setFormError(null);
      await invalidateBrokerData();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ brokerId, input }: { brokerId: string; input: BrokerUpdate }) =>
      api.updateBroker(brokerId, input),
    onSuccess: async () => {
      setForm(emptyBrokerForm);
      setEditingId(null);
      setFormError(null);
      await invalidateBrokerData();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteBroker,
    onSuccess: async () => {
      await invalidateBrokerData();
    },
  });

  const importMutation = useMutation({
    mutationFn: api.importBrokersCsv,
    onSuccess: async (result) => {
      setImportResult(result);
      await invalidateBrokerData();
    },
  });

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const activeError =
    formError ??
    brokersQuery.error?.message ??
    createMutation.error?.message ??
    updateMutation.error?.message ??
    deleteMutation.error?.message ??
    importMutation.error?.message;

  function updateFormField(field: keyof BrokerFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateImportField(field: Exclude<keyof ImportFormState, "file">, value: string) {
    setImportForm((current) => ({ ...current, [field]: value }));
  }

  function updateImportFile(event: ChangeEvent<HTMLInputElement>) {
    setImportForm((current) => ({ ...current, file: event.currentTarget.files?.[0] ?? null }));
    setImportResult(null);
  }

  function startEdit(broker: Broker) {
    setEditingId(broker.id);
    setForm(brokerToForm(broker));
    setFormError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyBrokerForm);
    setFormError(null);
  }

  function submitBroker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = formToBrokerInput(form);
    if (!input.name || !input.domain || !input.privacy_email || (!editingId && !input.id)) {
      setFormError("Name, domain, privacy email, and ID are required.");
      return;
    }
    if (editingId) {
      updateMutation.mutate({ brokerId: editingId, input: formToBrokerUpdate(form) });
      return;
    }
    createMutation.mutate(input);
  }

  function deleteBroker(broker: Broker) {
    const confirmed = window.confirm(`Remove ${broker.name} from Smokescreen?`);
    if (confirmed) {
      deleteMutation.mutate(broker.id);
    }
  }

  function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = importInput(importForm);
    if (!input) {
      setFormError("Choose a CSV file before importing.");
      return;
    }
    if (!input.name_col || !input.email_col) {
      setFormError("CSV name and email columns are required.");
      return;
    }
    setFormError(null);
    importMutation.mutate(input);
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {activeError ? <ApiError message={activeError} /> : null}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-normal">Brokers</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Keep contact details current so Smokescreen can send opt-out requests to the right privacy inboxes.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void brokersQuery.refetch();
          }}
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid gap-4">
          <div className="flex h-10 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search brokers"
              aria-label="Search brokers"
            />
          </div>

          {!brokersQuery.isLoading && filteredBrokers.length === 0 ? (
            <div className="rounded-md border bg-card px-6 py-12 text-center">
              <Search className="mx-auto h-10 w-10 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold tracking-normal">No brokers found</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Adjust the search or add a broker with the form on this page.
              </p>
            </div>
          ) : null}

          <div className="grid gap-3">
            {filteredBrokers.map((broker) => (
              <BrokerListItem
                key={broker.id}
                broker={broker}
                isEditing={editingId === broker.id}
                isDeleting={deleteMutation.isPending && deleteMutation.variables === broker.id}
                onEdit={() => startEdit(broker)}
                onDelete={() => deleteBroker(broker)}
              />
            ))}
          </div>
        </div>

        <div className="grid content-start gap-5">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{editingId ? "Edit broker" : "Add broker"}</CardTitle>
                {editingId ? <p className="mt-1 text-xs text-muted-foreground">{editingId}</p> : null}
              </div>
              {editingId ? (
                <Button type="button" variant="ghost" size="icon" aria-label="Cancel edit" onClick={cancelEdit}>
                  <X className="h-4 w-4" />
                </Button>
              ) : (
                <Plus className="h-4 w-4 text-muted-foreground" />
              )}
            </CardHeader>
            <CardContent>
              <form className="grid gap-3" onSubmit={submitBroker}>
                {!editingId ? (
                  <LabelledInput
                    label="ID"
                    value={form.id}
                    onChange={(value) => updateFormField("id", value)}
                    placeholder="people-search-site"
                    required
                  />
                ) : null}
                <LabelledInput
                  label="Name"
                  value={form.name}
                  onChange={(value) => updateFormField("name", value)}
                  placeholder="People Search Site"
                  required
                />
                <LabelledInput
                  label="Domain"
                  value={form.domain}
                  onChange={(value) => updateFormField("domain", value)}
                  placeholder="example.com"
                  required
                />
                <LabelledInput
                  label="Privacy email"
                  value={form.privacy_email}
                  onChange={(value) => updateFormField("privacy_email", value)}
                  placeholder="privacy@example.com"
                  required
                />
                <LabelledInput
                  label="Other domains"
                  value={form.aliases}
                  onChange={(value) => updateFormField("aliases", value)}
                  placeholder="alias.com, optout.example.com"
                />
                <label className="grid gap-1.5 text-sm font-medium">
                  Notes
                  <textarea
                    className={textareaClass}
                    value={form.notes}
                    onChange={(event) => updateFormField("notes", event.currentTarget.value)}
                    placeholder="Opt-out form details or review notes"
                  />
                </label>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="submit" disabled={isSaving}>
                    {editingId ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {isSaving ? "Saving" : editingId ? "Save changes" : "Add broker"}
                  </Button>
                  {editingId ? (
                    <Button type="button" variant="outline" onClick={cancelEdit}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Import CSV</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">Name and privacy email columns are required.</p>
              </div>
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <form className="grid gap-3" onSubmit={submitImport}>
                <label className="grid gap-1.5 text-sm font-medium">
                  CSV file
                  <input
                    className={cn(inputClass, "pt-2")}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={updateImportFile}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <LabelledInput
                    label="Name column"
                    value={importForm.name_col}
                    onChange={(value) => updateImportField("name_col", value)}
                    required
                  />
                  <LabelledInput
                    label="Email column"
                    value={importForm.email_col}
                    onChange={(value) => updateImportField("email_col", value)}
                    required
                  />
                  <LabelledInput
                    label="Domain column"
                    value={importForm.domain_col}
                    onChange={(value) => updateImportField("domain_col", value)}
                  />
                  <LabelledInput
                    label="ID column"
                    value={importForm.id_col}
                    onChange={(value) => updateImportField("id_col", value)}
                  />
                </div>
                <LabelledInput
                  label="Notes column"
                  value={importForm.notes_col}
                  onChange={(value) => updateImportField("notes_col", value)}
                />
                <Button type="submit" disabled={importMutation.isPending}>
                  <Upload className="h-4 w-4" />
                  {importMutation.isPending ? "Importing" : "Import brokers"}
                </Button>
                {importResult ? <ImportResultSummary result={importResult} /> : null}
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

function LabelledInput({
  label,
  value,
  onChange,
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      <input
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        required={required}
      />
    </label>
  );
}

function BrokerListItem({
  broker,
  isEditing,
  isDeleting,
  onEdit,
  onDelete,
}: {
  broker: Broker;
  isEditing: boolean;
  isDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className={cn(isEditing && "border-primary ring-1 ring-primary")}>
      <CardHeader className="items-start pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base font-semibold text-foreground">{broker.name}</CardTitle>
            <Badge variant="secondary">{broker.id}</Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Globe2 className="h-4 w-4" />
              <span className="break-all">{broker.domain || "No domain"}</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Mail className="h-4 w-4" />
              <span className="break-all">{broker.privacy_email || "No privacy email"}</span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="outline" size="icon" aria-label={`Edit ${broker.name}`} onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={`Delete ${broker.name}`}
            onClick={onDelete}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      {(broker.aliases.length > 0 || broker.notes.trim()) && (
        <CardContent className="grid gap-3">
          {broker.aliases.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {broker.aliases.map((alias) => (
                <Badge key={alias} variant="outline">
                  {alias}
                </Badge>
              ))}
            </div>
          ) : null}
          {broker.notes.trim() ? (
            <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{broker.notes}</p>
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}

function ImportResultSummary({ result }: { result: BrokerImportResult }) {
  const hasErrors = result.errors.length > 0;
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        hasErrors ? "border-destructive/40 bg-destructive/10" : "border-primary/30 bg-primary/10",
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        {hasErrors ? (
          <AlertTriangle className="h-4 w-4 text-destructive" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-primary" />
        )}
        Imported {result.imported}; skipped {result.skipped}
      </div>
      {hasErrors ? (
        <ul className="mt-2 grid gap-1 text-muted-foreground">
          {result.errors.slice(0, 3).map((error) => (
            <li key={error}>{error}</li>
          ))}
          {result.errors.length > 3 ? <li>{result.errors.length - 3} more rows need attention.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
