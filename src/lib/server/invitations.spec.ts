import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';

import { makeDatabaseLayer } from './database';
import { InvitationService } from './invitations';

const TestLayer = InvitationService.layerWithoutDependencies.pipe(
	Layer.provide(makeDatabaseLayer(':memory:'))
);

describe('InvitationService', () => {
	it.live('stores only a token hash and consumes an invitation once', () =>
		Effect.gen(function* () {
			const invitations = yield* InvitationService;
			const created = yield* invitations.create({
				email: 'Accountant@Example.com',
				role: 'accountant',
				invitedByUserId: 'admin-id'
			});

			expect(created.invitation.email).toBe('accountant@example.com');
			expect(created.token).toHaveLength(43);
			expect(JSON.stringify(yield* invitations.list)).not.toContain(created.token);
			expect((yield* invitations.inspect(created.token)).id).toBe(created.invitation.id);

			const accepted = yield* invitations.accept(created.invitation.id, 'accountant-id');
			expect(accepted.acceptedByUserId).toBe('accountant-id');
			const secondUse = yield* Effect.result(invitations.inspect(created.token));
			expect(Result.isFailure(secondUse)).toBe(true);
			if (Result.isFailure(secondUse)) expect(secondUse.failure.code).toBe('accepted');
		}).pipe(Effect.provide(TestLayer))
	);

	it.live('expires old links and revokes prior active links for an email', () =>
		Effect.gen(function* () {
			const invitations = yield* InvitationService;
			const expired = yield* invitations.create({
				email: 'expired@example.com',
				role: 'accountant',
				invitedByUserId: 'admin-id',
				expiresAt: new Date(Date.now() - 1000)
			});
			const expiredResult = yield* Effect.result(invitations.inspect(expired.token));
			expect(Result.isFailure(expiredResult)).toBe(true);
			if (Result.isFailure(expiredResult)) expect(expiredResult.failure.code).toBe('expired');

			const first = yield* invitations.create({
				email: 'repeat@example.com',
				role: 'accountant',
				invitedByUserId: 'admin-id'
			});
			yield* invitations.create({
				email: 'repeat@example.com',
				role: 'accountant',
				invitedByUserId: 'admin-id'
			});
			const firstResult = yield* Effect.result(invitations.inspect(first.token));
			expect(Result.isFailure(firstResult)).toBe(true);
			if (Result.isFailure(firstResult)) expect(firstResult.failure.code).toBe('revoked');
		}).pipe(Effect.provide(TestLayer))
	);
});
