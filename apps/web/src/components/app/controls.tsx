import type { ReactNode } from "react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type Option = { value: string; label: ReactNode };

/**
 * Base UI's Select wants an `items` map and its ToggleGroup is always
 * multi-valued. These two wrappers keep that API in one file instead of
 * spread across every page.
 */
export function SelectField({
  value,
  onChange,
  options,
  className,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  className?: string;
  id?: string;
}) {
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
  return (
    <Select items={items} value={value} onValueChange={(v) => onChange(String(v))}>
      <SelectTrigger className={className} id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function SingleToggle<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
}) {
  return (
    <ToggleGroup
      variant="outline"
      className={className}
      value={[value]}
      // Clicking the active item clears the array; keep the current value rather
      // than leaving the control with nothing selected.
      onValueChange={(next) => onChange((next[0] as T) ?? value)}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
