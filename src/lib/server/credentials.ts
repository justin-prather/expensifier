import { Schema } from 'effect';

export const Credentials = Schema.Struct({
	email: Schema.NonEmptyString,
	password: Schema.String.check(Schema.isMinLength(8))
});

export const SetupCredentials = Schema.Struct({
	name: Schema.NonEmptyString,
	email: Schema.NonEmptyString,
	password: Schema.String.check(Schema.isMinLength(8))
});

export const InvitationCredentials = Schema.Struct({
	name: Schema.NonEmptyString,
	password: Schema.String.check(Schema.isMinLength(8))
});
