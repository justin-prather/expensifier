const exactAmountPattern = /^(?:\d+(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?)$/;

export function parseAmountToMinor(value: string): number | null {
	const trimmed = value.trim().replace(/^\$/, '');
	if (!exactAmountPattern.test(trimmed)) return null;
	const normalized = trimmed.replace(/,/g, '');
	const [whole, fraction = ''] = normalized.split('.');
	const minor = `${whole}${fraction.padEnd(2, '0')}`;
	const parsed = Number.parseInt(minor, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseSignedAmountToMinor(value: string): number | null {
	const trimmed = value.trim();
	const negative = trimmed.startsWith('-');
	const unsigned = negative ? trimmed.slice(1) : trimmed;
	const parsed = parseAmountToMinor(unsigned);
	return parsed === null ? null : negative ? -parsed : parsed;
}

export function formatMinor(minor: number): string {
	if (!Number.isInteger(minor) || minor < 0) throw new Error('Invalid minor amount');
	const whole = Math.floor(minor / 100);
	const fraction = String(minor % 100).padStart(2, '0');
	return `${whole}.${fraction}`;
}

export function parseOptionalAmountToMinor(value: string | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	return parseAmountToMinor(trimmed);
}

export function parseOptionalSignedAmountToMinor(value: string | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	return parseSignedAmountToMinor(trimmed);
}

export function sumMinors(values: ReadonlyArray<number>): number {
	return values.reduce((total, value) => total + value, 0);
}

export function includedTaxMinor(totalMinor: number, ratePercent: number): number {
	return Math.round((totalMinor * ratePercent) / (100 + ratePercent));
}

export function addedTaxMinor(subtotalMinor: number, ratePercent: number): number {
	return Math.round((subtotalMinor * ratePercent) / 100);
}
