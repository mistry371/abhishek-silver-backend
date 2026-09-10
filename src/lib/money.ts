/** Customer prices are whole rupees, matching the storefront price engine. */
export const rupees = (value: number) => Math.round(value);

/** Two-decimal amounts (invoices, expenses, purchase lines). */
export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Weights in grams / carats. */
export const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
