import { error } from '@sveltejs/kit';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

export const roles = ['admin', 'accountant'] as const;
export type Role = (typeof roles)[number];

export const permissions = [
	'expenses:view',
	'expenses:edit',
	'expenses:retry-ocr',
	'expenses:approve',
	'expenses:reject',
	'expenses:reopen',
	'audit:view',
	'users:manage',
	'settings:manage',
	'backups:manage',
	'integrations:manage'
] as const;
export type Permission = (typeof permissions)[number];

const accountantPermissions = new Set<Permission>([
	'expenses:view',
	'expenses:edit',
	'expenses:retry-ocr',
	'expenses:approve',
	'expenses:reject',
	'expenses:reopen',
	'audit:view'
]);

export function isRole(value: unknown): value is Role {
	return typeof value === 'string' && roles.includes(value as Role);
}

export function hasPermission(role: unknown, permission: Permission): boolean {
	if (role === 'admin') return true;
	return role === 'accountant' && accountantPermissions.has(permission);
}

interface AuthenticatedUser {
	readonly id: string;
	readonly email?: string | null;
	readonly role?: string | null;
}

export function requireUser(user: AuthenticatedUser | null): AuthenticatedUser {
	if (!user) error(401, 'Authentication required');
	return user;
}

export function requirePermission(
	user: AuthenticatedUser | null,
	permission: Permission
): AuthenticatedUser {
	const authenticated = requireUser(user);
	if (!hasPermission(authenticated.role, permission)) error(403, 'Permission denied');
	return authenticated;
}

export const authAccessControl = createAccessControl(defaultStatements);
export const adminRole = authAccessControl.newRole({ ...adminAc.statements });
export const accountantRole = authAccessControl.newRole({ user: [], session: [] });
