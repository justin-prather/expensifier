import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export const defaultFilenameTemplate =
	'{date} {vendor} {amount} {paymentAccount} {notes} {billable}.{extension}';
export const defaultDestinationTemplate = 'processed/{year}/{month} {monthName}';

const monthNames = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

const knownTokens = new Set([
	'date',
	'year',
	'month',
	'monthName',
	'vendor',
	'amount',
	'currency',
	'paymentAccount',
	'notes',
	'billable',
	'billableSubdir',
	'client',
	'extension',
	'expenseId'
]);

export interface TemplateValues {
	readonly date: string;
	readonly vendor: string;
	readonly amount: string;
	readonly currency: string;
	readonly paymentAccount: string;
	readonly notes: string;
	readonly billable: boolean;
	readonly client: string;
	readonly extension: string;
	readonly expenseId: string;
}

export class TemplateError extends Error {}

function sanitizeValue(value: string): string {
	const withoutControlChars = Array.from(value)
		.map((char) => {
			const code = char.codePointAt(0) ?? 0;
			if (code < 32 || code === 127) return '-';
			return /[/\\<>:"|?*]/.test(char) ? '-' : char;
		})
		.join('');
	return withoutControlChars.replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
}

export function sanitizeFilenameValue(value: string): string {
	return sanitizeValue(value);
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function validateTemplate(template: string): void {
	if (template.trim() === '') throw new TemplateError('Template must not be empty');
	if (template.includes('\u0000'))
		throw new TemplateError('Template must not contain control characters');
	for (const match of template.matchAll(/\{(\w+)\}/g)) {
		if (!knownTokens.has(match[1])) {
			throw new TemplateError(`Unknown template token {${match[1]}}`);
		}
	}
}

function renderTokens(template: string, values: TemplateValues): string {
	return template.replace(/\{(\w+)\}/g, (_, token: string) => {
		switch (token) {
			case 'date':
				return values.date;
			case 'year':
			case 'month':
			case 'monthName': {
				const date = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}$/.exec(values.date);
				if (!date) return '';
				if (token === 'year') return date[1];
				if (token === 'month') return date[2];
				return monthNames[Number(date[2]) - 1];
			}
			case 'vendor':
				return values.vendor;
			case 'amount':
				return values.amount;
			case 'currency':
				return values.currency;
			case 'paymentAccount':
				return values.paymentAccount;
			case 'notes':
				return values.notes;
			case 'billable':
				return values.billable ? 'billable' : '';
			case 'billableSubdir':
				return values.billable ? 'billable' : '';
			case 'client':
				return values.client;
			case 'extension':
				return values.extension;
			case 'expenseId':
				return values.expenseId;
			default:
				return '';
		}
	});
}

export function renderFilename(template: string, values: TemplateValues): string {
	validateTemplate(template);
	const extension = sanitizeValue(values.extension).replace(/^\.+/, '');
	if (!extension) throw new TemplateError('File extension is required');

	const rendered = renderTokens(template, values);
	const dotIndex = rendered.lastIndexOf('.');
	const baseWithExt = dotIndex > 0 ? rendered.slice(0, dotIndex) : rendered;
	const base = sanitizeValue(baseWithExt.replace(/\s+/g, ' ').trim());

	const budget = 255 - extension.length - 1;
	let fitted = base || 'untitled';
	if (utf8Length(fitted) > budget) {
		const parts = fitted.split(' ');
		const tail = parts.filter((part) =>
			[values.date, values.amount, values.paymentAccount].some(
				(kept) => kept !== '' && part.includes(sanitizeValue(kept))
			)
		);
		const flexible = parts.filter((part) => !tail.includes(part));
		fitted = [...tail, ...flexible].join(' ');
		while (fitted.length > 0 && utf8Length(fitted) > budget) {
			fitted = fitted.slice(0, -1).trimEnd();
		}
	}
	if (!fitted) throw new TemplateError('Rendered filename exceeds platform limits');

	return `${fitted}.${extension}`;
}

export function renderDestination(template: string, values: TemplateValues): string {
	validateTemplate(template);
	if (values.billable) return 'processed/billable';
	const rendered = renderTokens(template, values);
	const segments = rendered
		.split('/')
		.map((segment) => sanitizeValue(segment))
		.filter((segment) => segment !== '' && segment !== '.');
	if (segments.some((segment) => segment === '..')) {
		throw new TemplateError('Destination must not contain traversal segments');
	}
	if (segments.length === 0) throw new TemplateError('Rendered destination is empty');
	const joined = segments.join('/');
	if (joined.length > 1024) throw new TemplateError('Rendered destination exceeds path limits');
	return joined;
}

export class TemplateService extends Context.Service<
	TemplateService,
	{
		readonly previewFilename: (values: TemplateValues) => Effect.Effect<string>;
		readonly previewDestination: (values: TemplateValues) => Effect.Effect<string>;
	}
>()('expensifier/TemplateService') {
	static readonly layerWithoutDependencies = Layer.effect(
		TemplateService,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const loadTemplates = Effect.gen(function* () {
				const rows = yield* sql<{ readonly key: string; readonly value: string }>`
					SELECT key, value FROM app_settings
					WHERE key IN ('filename_template', 'destination_template')
				`;
				const stored = new Map(rows.map((row) => [row.key, row.value]));
				return {
					filename: stored.get('filename_template') ?? defaultFilenameTemplate,
					destination: stored.get('destination_template') ?? defaultDestinationTemplate
				};
			}).pipe(Effect.orDie);

			const previewFilename = Effect.fn('TemplateService.previewFilename')(function* (
				values: TemplateValues
			) {
				const templates = yield* loadTemplates;
				return renderFilename(templates.filename, values);
			}, Effect.orDie);

			const previewDestination = Effect.fn('TemplateService.previewDestination')(function* (
				values: TemplateValues
			) {
				const templates = yield* loadTemplates;
				return renderDestination(templates.destination, values);
			}, Effect.orDie);

			return TemplateService.of({ previewFilename, previewDestination });
		})
	);
}
