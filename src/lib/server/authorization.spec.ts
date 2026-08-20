import { describe, expect, it } from 'vitest';

import { accountantRole, hasPermission, requirePermission, requireUser } from './authorization';

describe('authorization', () => {
	it('grants expense review permissions to accountants', () => {
		expect(hasPermission('accountant', 'expenses:view')).toBe(true);
		expect(hasPermission('accountant', 'expenses:approve')).toBe(true);
		expect(hasPermission('accountant', 'expenses:retry-ocr')).toBe(true);
	});

	it('denies administrative permissions to accountants', () => {
		expect(hasPermission('accountant', 'users:manage')).toBe(false);
		expect(hasPermission('accountant', 'settings:manage')).toBe(false);
		expect(accountantRole.authorize({ user: ['list'] }).success).toBe(false);
		let denied: unknown;
		try {
			requirePermission({ id: 'accountant-id', role: 'accountant' }, 'users:manage');
		} catch (error) {
			denied = error;
		}
		expect(denied).toMatchObject({ status: 403, body: { message: 'Permission denied' } });
	});

	it('grants all defined permissions to admins and rejects anonymous users', () => {
		expect(hasPermission('admin', 'users:manage')).toBe(true);
		expect(hasPermission('admin', 'backups:manage')).toBe(true);
		let anonymous: unknown;
		try {
			requireUser(null);
		} catch (error) {
			anonymous = error;
		}
		expect(anonymous).toMatchObject({
			status: 401,
			body: { message: 'Authentication required' }
		});
	});
});
