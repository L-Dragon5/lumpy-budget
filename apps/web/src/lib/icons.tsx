import type { CategoryIconName } from "@lumpy/contracts";
import {
  BabyIcon, BanknoteIcon, BikeIcon, BookIcon, BriefcaseIcon, Building2Icon, BusIcon, CarIcon,
  CatIcon, ClapperboardIcon, CloudIcon, CoffeeIcon, CreditCardIcon, DogIcon, DropletIcon,
  DumbbellIcon, FlowerIcon, FuelIcon, Gamepad2Icon, GiftIcon, GraduationCapIcon, HammerIcon,
  HeartPulseIcon, HouseIcon, LandmarkIcon, LaptopIcon, MusicIcon, PackageIcon, PhoneIcon,
  PiggyBankIcon, PizzaIcon, PlaneIcon, ReceiptIcon, RepeatIcon, ScissorsIcon, ShieldCheckIcon,
  ShirtIcon, ShoppingBagIcon, ShoppingCartIcon, SparklesIcon, StethoscopeIcon, TagIcon,
  TicketIcon, TreePineIcon, TrendingUpIcon, UtensilsCrossedIcon, WifiIcon, WineIcon, WrenchIcon,
  ZapIcon, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Name to glyph. Explicit imports rather than a dynamic lookup over all 1,800
 * lucide icons: the set is small and curated, and this way only what is used
 * ships. An unknown name draws the generic tag instead of blowing up a row.
 */
const ICONS: Record<CategoryIconName, LucideIcon> = {
  cart: ShoppingCartIcon,
  utensils: UtensilsCrossedIcon,
  coffee: CoffeeIcon,
  pizza: PizzaIcon,
  wine: WineIcon,
  fuel: FuelIcon,
  bag: ShoppingBagIcon,
  shirt: ShirtIcon,
  tag: TagIcon,
  film: ClapperboardIcon,
  music: MusicIcon,
  gamepad: Gamepad2Icon,
  ticket: TicketIcon,
  book: BookIcon,
  graduation: GraduationCapIcon,
  health: HeartPulseIcon,
  stethoscope: StethoscopeIcon,
  dumbbell: DumbbellIcon,
  plane: PlaneIcon,
  car: CarIcon,
  bus: BusIcon,
  bike: BikeIcon,
  home: HouseIcon,
  building: Building2Icon,
  tree: TreePineIcon,
  flower: FlowerIcon,
  hammer: HammerIcon,
  wrench: WrenchIcon,
  droplet: DropletIcon,
  zap: ZapIcon,
  wifi: WifiIcon,
  phone: PhoneIcon,
  laptop: LaptopIcon,
  cloud: CloudIcon,
  dog: DogIcon,
  cat: CatIcon,
  baby: BabyIcon,
  scissors: ScissorsIcon,
  gift: GiftIcon,
  sparkles: SparklesIcon,
  repeat: RepeatIcon,
  shield: ShieldCheckIcon,
  landmark: LandmarkIcon,
  "piggy-bank": PiggyBankIcon,
  "credit-card": CreditCardIcon,
  banknote: BanknoteIcon,
  receipt: ReceiptIcon,
  briefcase: BriefcaseIcon,
  package: PackageIcon,
  "trending-up": TrendingUpIcon,
};

export const iconFor = (name: string | null | undefined): LucideIcon =>
  (name && ICONS[name as CategoryIconName]) || TagIcon;

export function CategoryIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Icon = iconFor(name);
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** Name and glyph together, for a table cell or a dropdown row. */
export function CategoryLabel({
  name,
  icon,
  className,
}: {
  name: string;
  icon: string | null | undefined;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <CategoryIcon name={icon} />
      <span className="truncate">{name}</span>
    </span>
  );
}
