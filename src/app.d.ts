import type { auth } from '$lib/server/auth';

type AuthSession = typeof auth.$Infer.Session;

declare global {
	namespace App {
		interface Locals {
			user: AuthSession['user'] | null;
			session: AuthSession['session'] | null;
		}
	}
}
