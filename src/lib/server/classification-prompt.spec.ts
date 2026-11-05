import { describe, expect, it } from 'vitest';

import { buildClassificationInstructions } from './classification-prompt';

describe('classification prompt policy boundary', () => {
	it('keeps the default prompt independent of private runtime policy', () => {
		const prompt = buildClassificationInstructions(null);

		expect(prompt).not.toContain('Deployment-specific policy follows');
		expect(prompt).not.toContain('Fixture Private Client');
		expect(prompt).toContain('only supplied candidate IDs');
		expect(prompt).toContain('Return only JSON matching this schema:');
	});

	it('includes an explicitly configured policy only in that deployment prompt', () => {
		const policy = 'Fixture Vendor charges belong to Fixture Private Client.';
		const prompt = buildClassificationInstructions(policy);

		expect(prompt).toContain('Deployment-specific policy follows');
		expect(prompt).toContain(policy);
		expect(prompt).toContain('Apply it only within the supplied candidate IDs');
		expect(prompt.endsWith('Return only JSON matching this schema: ')).toBe(true);
		expect(buildClassificationInstructions(null)).not.toContain(policy);
	});
});
