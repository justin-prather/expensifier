import { describe, expect, it } from 'vitest';

import { formatMinor, parseAmountToMinor, parseOptionalAmountToMinor, sumMinors } from './money';

describe('parseAmountToMinor', () => {
	it('parses plain decimal amounts into integer minor units', () => {
		expect(parseAmountToMinor('12.34')).toBe(1234);
		expect(parseAmountToMinor('0.05')).toBe(5);
		expect(parseAmountToMinor('7')).toBe(700);
		expect(parseAmountToMinor('  42.10  ')).toBe(4210);
	});

	it('accepts thousands separators and a leading currency symbol', () => {
		expect(parseAmountToMinor('1,234.56')).toBe(123456);
		expect(parseAmountToMinor('$12,345.67')).toBe(1234567);
		expect(parseAmountToMinor('$0.99')).toBe(99);
	});

	it('rejects malformed amounts', () => {
		expect(parseAmountToMinor('')).toBeNull();
		expect(parseAmountToMinor('abc')).toBeNull();
		expect(parseAmountToMinor('12.345')).toBeNull();
		expect(parseAmountToMinor('1,23.45')).toBeNull();
		expect(parseAmountToMinor('-3.20')).toBeNull();
		expect(parseAmountToMinor('1..2')).toBeNull();
	});
});

describe('formatMinor', () => {
	it('formats minor units with two decimals', () => {
		expect(formatMinor(123456)).toBe('1234.56');
		expect(formatMinor(5)).toBe('0.05');
		expect(formatMinor(100)).toBe('1.00');
	});

	it('rejects negative or fractional minor amounts', () => {
		expect(() => formatMinor(-1)).toThrow(/Invalid minor amount/);
		expect(() => formatMinor(10.5)).toThrow(/Invalid minor amount/);
	});
});

describe('parseOptionalAmountToMinor', () => {
	it('maps blank input to null', () => {
		expect(parseOptionalAmountToMinor('')).toBeNull();
		expect(parseOptionalAmountToMinor('   ')).toBeNull();
		expect(parseOptionalAmountToMinor(null)).toBeNull();
		expect(parseOptionalAmountToMinor(undefined)).toBeNull();
	});

	it('delegates non-blank input to parseAmountToMinor', () => {
		expect(parseOptionalAmountToMinor('9.99')).toBe(999);
		expect(parseOptionalAmountToMinor('oops')).toBeNull();
	});
});

describe('sumMinors', () => {
	it('sums integer minor amounts exactly', () => {
		expect(sumMinors([101, 202, 303])).toBe(606);
		expect(sumMinors([])).toBe(0);
	});
});
