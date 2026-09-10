import type { CustomizationKey, Gender, MetalType, PurityCode, SizingType } from "@/contracts/common";
import type { CustomizationOption } from "@/contracts/storefront";

export const METALS = ["gold", "silver"] as const satisfies readonly MetalType[];
export const PURITIES = ["24k", "22k", "18k", "14k", "999", "925"] as const satisfies readonly PurityCode[];
export const GENDERS = ["women", "men", "kids", "unisex"] as const satisfies readonly Gender[];

export const PURITIES_BY_METAL: Record<MetalType, PurityCode[]> = {
  gold: ["24k", "22k", "18k", "14k"],
  silver: ["999", "925"],
};

export const metalLabels: Record<MetalType, string> = { gold: "Gold", silver: "Silver" };

export const purityLabels: Record<PurityCode, string> = {
  "24k": "24KT",
  "22k": "22KT",
  "18k": "18KT",
  "14k": "14KT",
  "999": "999 Fine Silver",
  "925": "925 Sterling Silver",
};

export const purityFineness: Record<PurityCode, number> = { "24k": 999, "22k": 916, "18k": 750, "14k": 585, "999": 999, "925": 925 };

export const genderLabels: Record<Gender, string> = { women: "Women", men: "Men", kids: "Kids", unisex: "Unisex" };

export function sizeLabel(sizing: SizingType | null, value: string) {
  switch (sizing) {
    case "ring":
      return `Size ${value}`;
    case "bangle":
      return `${value}"`;
    case "chain":
    case "bracelet":
      return `${value} in`;
    default:
      return value;
  }
}

export const customizationCatalog: Record<CustomizationKey, CustomizationOption> = {
  engraving: { id: "engraving", type: "text", label: "Engraving", required: false, maxLength: 12, helpText: "Up to 12 characters." },
  initial: {
    id: "initial",
    type: "select",
    label: "Initial",
    required: false,
    options: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({ value: letter, label: letter })),
  },
  note: {
    id: "note",
    type: "textarea",
    label: "Special request",
    required: false,
    maxLength: 240,
    helpText: "Our team will confirm feasibility before your order is processed.",
  },
};
