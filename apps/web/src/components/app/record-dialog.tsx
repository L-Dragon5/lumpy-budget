import { useState, type FormEvent, type ReactNode } from "react";
import { PlusIcon, TrashIcon } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ApiError } from "@/lib/api";
import { centsToInput, toCents } from "@/lib/format";

/**
 * A form in a dialog. Deliberately not a form abstraction: each page writes its
 * own fields, this only carries the submit plumbing and the error surface.
 */
export function RecordDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  pending,
  error,
  children,
  submitLabel = "Save",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  onSubmit: () => void;
  pending?: boolean;
  error?: unknown;
  children: ReactNode;
  submitLabel?: string;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <FieldGroup className="my-4">{children}</FieldGroup>
          {error ? <FormError error={error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FormError({ error }: { error: unknown }) {
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertDescription>
        {issues.length > 0
          ? issues.map((i) => `${i.path}: ${i.message}`).join("; ")
          : error instanceof Error
            ? error.message
            : "Something went wrong"}
      </AlertDescription>
    </Alert>
  );
}

/** A money field that keeps dollars in the box and cents in the state. */
export function MoneyField({
  label,
  cents,
  onChange,
  description,
  required = true,
}: {
  label: string;
  cents: number | null;
  onChange: (cents: number | null) => void;
  description?: string;
  required?: boolean;
}) {
  const [text, setText] = useState(centsToInput(cents));
  const invalid = required && toCents(text) === null;
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        inputMode="decimal"
        placeholder="0.00"
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          onChange(toCents(e.target.value));
        }}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button onClick={onClick}>
      <PlusIcon data-icon="inline-start" />
      {children}
    </Button>
  );
}

export function DeleteButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={`Delete ${label}`}>
            <TrashIcon />
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
