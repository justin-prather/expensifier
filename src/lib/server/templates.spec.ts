import { describe, expect, it } from 'vitest';

import {
	defaultDestinationTemplate,
	defaultFilenameTemplate,
	renderDestination,
	renderFilename,
	sanitizeFilenameValue,
	validateTemplate,
	TemplateError,
	type TemplateValues
} from './templates';

const baseValues: TemplateValues = {
	date: '2026-08-19',
	vendor: 'Home Depot',
	amount: '123.45',
	currency: 'CAD',
	paymentAccount: '11190-WISE-USD',
	notes: 'shelving',
	billable: false,
	client: '',
	extension: 'pdf',
	expenseId: 'e1'
};

describe('renderFilename', () => {
	it('renders the default template like the legacy convention', () => {
		expect(renderFilename(defaultFilenameTemplate, baseValues)).toBe(
			'2026-08-19 Home Depot 123.45 11190-WISE-USD shelving.pdf'
		);
	});

	it('appends the billable marker for billable expenses', () => {
		const filename = renderFilename(defaultFilenameTemplate, { ...baseValues, billable: true });
		expect(filename).toBe('2026-08-19 Home Depot 123.45 11190-WISE-USD shelving billable.pdf');
	});

	it('sanitizes filesystem-hostile characters', () => {
		const filename = renderFilename(defaultFilenameTemplate, {
			...baseValues,
			vendor: 'A/B: C<D>E "F" G|H?I*J',
			notes: ''
		});
		expect(filename).not.toMatch(/[/\\<>:"|?*]/);
		expect(filename).toContain('A-B- C-D-E -F- G-H-I-J');
	});

	it('keeps the rendered filename within the 255-byte platform budget', () => {
		const filename = renderFilename(defaultFilenameTemplate, {
			...baseValues,
			vendor: `V${'ery long vendor name '.repeat(20)}`
		});
		expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(255);
		expect(filename.endsWith('.pdf')).toBe(true);
	});

	it('preserves priority segments when truncating', () => {
		const filename = renderFilename(defaultFilenameTemplate, {
			...baseValues,
			vendor: `V${'ery long vendor name '.repeat(20)}`
		});
		for (const kept of [baseValues.date, baseValues.amount, baseValues.paymentAccount]) {
			expect(filename).toContain(kept);
		}
	});

	it('requires a non-empty extension', () => {
		expect(() => renderFilename(defaultFilenameTemplate, { ...baseValues, extension: '' })).toThrow(
			TemplateError
		);
	});
});

describe('renderDestination', () => {
	it('routes non-billable expenses by receipt year and month', () => {
		expect(renderDestination(defaultDestinationTemplate, baseValues)).toBe(
			'processed/2026/08 August'
		);
	});

	it.each([
		['2026-10-15', 'processed/2026/10 October'],
		['2026-01-31', 'processed/2026/01 January'],
		['2025-12-31', 'processed/2025/12 December']
	])('files receipt date %s into %s', (date, destination) => {
		expect(renderDestination(defaultDestinationTemplate, { ...baseValues, date })).toBe(
			destination
		);
	});

	it('allows previews before a valid receipt date is entered', () => {
		for (const date of ['', '2026-13-01', '2026-1-01']) {
			expect(renderDestination(defaultDestinationTemplate, { ...baseValues, date })).toBe(
				'processed'
			);
		}
	});

	it('routes billable expenses to processed/billable', () => {
		expect(renderDestination(defaultDestinationTemplate, { ...baseValues, billable: true })).toBe(
			'processed/billable'
		);
	});

	it('holds billable expenses before configured date-based filing', () => {
		expect(renderDestination('processed/2026/08', { ...baseValues, billable: true })).toBe(
			'processed/billable'
		);
		expect(renderDestination('processed/2026/08', baseValues)).toBe('processed/2026/08');
	});

	it('neutralizes traversal segments instead of escaping the managed root', () => {
		const destination = renderDestination('{vendor}/receipts', { ...baseValues, vendor: '..' });
		expect(destination).toBe('receipts');
		expect(destination.split('/')).not.toContain('..');
	});

	it('drops empty segments produced by blank values', () => {
		expect(renderDestination('processed/{client}/{billableSubdir}', baseValues)).toBe('processed');
	});
});

describe('sanitizeFilenameValue', () => {
	it('replaces control and separator characters with dashes', () => {
		expect(sanitizeFilenameValue('a/b\\c')).toBe('a-b-c');
		expect(sanitizeFilenameValue('bad\u0007name')).toBe('bad-name');
	});

	it('trims leading and trailing dots and whitespace', () => {
		expect(sanitizeFilenameValue('  .hidden.  ')).toBe('hidden');
	});
});

describe('validateTemplate', () => {
	it('accepts known tokens', () => {
		expect(() => validateTemplate('{date} {vendor} {billableSubdir}')).not.toThrow();
	});

	it('rejects empty templates and unknown tokens', () => {
		expect(() => validateTemplate('   ')).toThrow(TemplateError);
		expect(() => validateTemplate('{nonsense}')).toThrow(TemplateError);
	});
});
